import type { VulnRange } from "@/lib/version";
import { NonRetryableError } from "@/services/jobs/service";

export interface FeedEntry {
  id: string;
  title: string;
  cve: string | null;
  cvss: number | null;
  software_type: "plugin" | "theme" | "core";
  software_slug: string;
  affected_versions: VulnRange[];
  fixed_in: string | null;
}

/**
 * The production feed, deliberately, not the scanner feed.
 *
 * Both are free, both need the same v3 API key, and both were fetched and
 * parsed with this same parser to compare them. The scanner feed is a
 * detection-only format: measured against the live response, 0 of its 42,279
 * entries carried a CVSS score and 0 carried a CVE. That is fatal here rather
 * than merely thin, because `severityFromCvss(null)` returns null and
 * `computeGrade` weights a null severity as "low" (-5). On the scanner feed
 * every vulnerability on every site would score identically, so a critical
 * unauthenticated RCE and a trivial admin-only XSS would move a security
 * grade by exactly the same amount — the grade would still be a number, and
 * it would be meaningless in precisely the cases it exists for.
 *
 * The production feed measured 43,060 entries (more, not fewer), 100% with a
 * CVSS score, 92% with a CVE, split 2,880 critical / 8,638 high / 31,372
 * medium / 170 low. It costs ~155MB per fetch against the scanner feed's
 * ~79MB, which is the only thing traded away.
 */
export const WORDFENCE_FEED_URL =
  "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production";

const TYPES = new Set(["plugin", "theme", "core"]);

export function parseWordfenceFeed(raw: unknown): FeedEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const entries: FeedEntry[] = [];
  for (const [uuid, recRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!recRaw || typeof recRaw !== "object") continue;
    const rec = recRaw as {
      title?: unknown; cve?: unknown; cvss?: { score?: unknown };
      software?: Array<{
        type?: unknown; slug?: unknown;
        affected_versions?: Record<string, Partial<VulnRange>>;
        patched_versions?: unknown[];
      }>;
    };
    if (!Array.isArray(rec.software)) continue;
    for (const sw of rec.software) {
      const type = String(sw?.type ?? "");
      const slug = String(sw?.slug ?? "");
      if (!TYPES.has(type) || !slug) continue;
      const ranges: VulnRange[] = Object.values(sw.affected_versions ?? {})
        .filter((r): r is VulnRange =>
          typeof r?.from_version === "string" && typeof r?.to_version === "string")
        .map((r) => ({
          from_version: r.from_version,
          from_inclusive: r.from_inclusive !== false,
          to_version: r.to_version,
          to_inclusive: r.to_inclusive !== false,
        }));
      if (ranges.length === 0) continue;
      const patched = (sw.patched_versions ?? []).map(String).filter(Boolean);
      const score = rec.cvss && typeof rec.cvss === "object" ? Number((rec.cvss as { score?: unknown }).score) : NaN;
      entries.push({
        id: `${uuid}:${type}:${slug}`,
        title: typeof rec.title === "string" ? rec.title : slug,
        cve: typeof rec.cve === "string" && rec.cve ? rec.cve : null,
        cvss: Number.isFinite(score) ? score : null,
        software_type: type as FeedEntry["software_type"],
        software_slug: slug,
        affected_versions: ranges,
        fixed_in: patched[0] ?? null,
      });
    }
  }
  return entries;
}

export async function fetchWordfenceFeed(
  apiKey: string, fetchImpl: typeof fetch = fetch,
): Promise<FeedEntry[]> {
  const res = await fetchImpl(WORDFENCE_FEED_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 429) {
    // A 429 means the key is valid but the window is spent — retrying at the
    // ladder's 60s/300s cadence cannot succeed (Wordfence's rate-limit window
    // is hours) and only spends quota the next legitimate attempt needs.
    // Surface Retry-After (if the API sent one) so an operator checking
    // jobs.last_error knows when it's worth trying again by hand.
    // Retry-After is upstream-controlled and flows straight into
    // jobs.last_error; truncate it so a misbehaving/malicious upstream can't
    // write an arbitrary-length value into that column.
    const retryAfter = res.headers.get("retry-after")?.slice(0, 64);
    const wait = retryAfter ? ` (Retry-After: ${retryAfter})` : "";
    throw new NonRetryableError(`Wordfence feed rate limited: HTTP 429${wait}`);
  }
  if (!res.ok) throw new Error(`Wordfence feed request failed: HTTP ${res.status}`);
  const entries = parseWordfenceFeed(await res.json());
  if (entries.length === 0) {
    // The feed is never legitimately empty — a zero-entry parse means
    // the response shape changed. Fail loudly so it lands in jobs.last_error.
    throw new Error("Wordfence feed parsed to 0 entries — response shape changed?");
  }
  return entries;
}
