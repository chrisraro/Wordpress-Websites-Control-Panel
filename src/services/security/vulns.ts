import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import { compareVersions, versionInRange } from "@/lib/version";
import type { InventoryPayload } from "@/services/inventory/types";
import { severityFromCvss, type Severity } from "./types";

export interface VulnMatch {
  feed_id: string;
  component: string;            // "plugin:<slug>" | "theme:<slug>" | "core"
  installed_version: string;
  severity: Severity | null;
}

/** The advisory a feed row belongs to; see the id scheme in wordfence.ts. */
function advisoryId(feedId: string): string {
  return feedId.split(":")[0];
}

/**
 * One advisory, one finding — even when the feed carries several rows for it.
 *
 * A vulnerability maintained across parallel version branches has one feed row
 * per branch, and those ranges can overlap: miniorange-oauth's seven branches
 * are all "* up to <branch>.5.3", so a site on 18.0 falls inside every one of
 * them. Reporting seven identical findings for one CVE would be noise, and
 * the site_vulnerabilities unique key (site_id, feed_id, component) would not
 * stop it, because the feed_ids genuinely differ.
 *
 * The row kept is the one that tells the operator the truth about what to do:
 * the smallest fix strictly above what is installed — 18.5.4 for a site on
 * 18.0, not 50.5.4. A row with no fix at all loses to any row that has one,
 * since "upgrade to X" beats "no patch available" when both describe the same
 * flaw. Ties and no-fix-anywhere keep the first, which is feed order.
 */
function bestPerAdvisory(found: Array<{ match: VulnMatch; fixedIn: string | null }>, installed: string) {
  const best = new Map<string, { match: VulnMatch; fixedIn: string | null }>();
  for (const cand of found) {
    const key = advisoryId(cand.match.feed_id);
    const held = best.get(key);
    if (!held) { best.set(key, cand); continue; }
    const candUsable = cand.fixedIn !== null && compareVersions(cand.fixedIn, installed) > 0;
    const heldUsable = held.fixedIn !== null && compareVersions(held.fixedIn, installed) > 0;
    if (!candUsable) continue;
    if (!heldUsable) { best.set(key, cand); continue; }
    if (compareVersions(cand.fixedIn as string, held.fixedIn as string) < 0) best.set(key, cand);
  }
  return [...best.values()].map((c) => c.match);
}

export function matchInventory(entries: FeedEntry[], inv: InventoryPayload): VulnMatch[] {
  const matches: VulnMatch[] = [];
  const targets: Array<{ type: FeedEntry["software_type"]; slug: string; version: string; component: string }> = [
    { type: "core", slug: "wordpress", version: inv.wp_version, component: "core" },
    ...inv.plugins.map((p) => ({ type: "plugin" as const, slug: p.name, version: p.version, component: `plugin:${p.name}` })),
    ...inv.themes.map((t) => ({ type: "theme" as const, slug: t.name, version: t.version, component: `theme:${t.name}` })),
  ];
  for (const target of targets) {
    const found: Array<{ match: VulnMatch; fixedIn: string | null }> = [];
    for (const e of entries) {
      if (e.software_type !== target.type || e.software_slug !== target.slug) continue;
      if (e.affected_versions.some((r) => versionInRange(target.version, r))) {
        found.push({
          match: {
            feed_id: e.id,
            component: target.component,
            installed_version: target.version,
            severity: severityFromCvss(e.cvss),
          },
          fixedIn: e.fixed_in,
        });
      }
    }
    matches.push(...bestPerAdvisory(found, target.version));
  }
  return matches;
}
