import type { VulnRange } from "@/lib/version";

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

export const WORDFENCE_SCANNER_URL =
  "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/scanner";

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
  const res = await fetchImpl(WORDFENCE_SCANNER_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Wordfence feed request failed: HTTP ${res.status}`);
  return parseWordfenceFeed(await res.json());
}
