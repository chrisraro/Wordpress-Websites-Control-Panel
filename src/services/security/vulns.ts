import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import { versionInRange } from "@/lib/version";
import type { InventoryPayload } from "@/services/inventory/types";
import { severityFromCvss, type Severity } from "./types";

export interface VulnMatch {
  feed_id: string;
  component: string;            // "plugin:<slug>" | "theme:<slug>" | "core"
  installed_version: string;
  severity: Severity | null;
}

export function matchInventory(entries: FeedEntry[], inv: InventoryPayload): VulnMatch[] {
  const matches: VulnMatch[] = [];
  const targets: Array<{ type: FeedEntry["software_type"]; slug: string; version: string; component: string }> = [
    { type: "core", slug: "wordpress", version: inv.wp_version, component: "core" },
    ...inv.plugins.map((p) => ({ type: "plugin" as const, slug: p.name, version: p.version, component: `plugin:${p.name}` })),
    ...inv.themes.map((t) => ({ type: "theme" as const, slug: t.name, version: t.version, component: `theme:${t.name}` })),
  ];
  for (const target of targets) {
    for (const e of entries) {
      if (e.software_type !== target.type || e.software_slug !== target.slug) continue;
      if (e.affected_versions.some((r) => versionInRange(target.version, r))) {
        matches.push({
          feed_id: e.id,
          component: target.component,
          installed_version: target.version,
          severity: severityFromCvss(e.cvss),
        });
      }
    }
  }
  return matches;
}
