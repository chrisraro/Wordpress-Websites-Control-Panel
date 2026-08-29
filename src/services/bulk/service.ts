import type { InventoryPayload } from "@/services/inventory/types";
import type { ManageAction } from "@/services/manage/types";
import { canDeleteTheme } from "@/services/themes/safety";
import type { JobsRepo } from "@/services/jobs/repo";
import type { SitesRepo } from "@/services/sites/repo";
import type { BulkKind, BulkSplit, BulkTarget } from "./types";

export function toManageAction(kind: BulkKind, target: BulkTarget, id: string): ManageAction {
  if (target === "plugin") {
    switch (kind) {
      case "update": return { kind: "update_plugin", file: id };
      case "activate": return { kind: "activate_plugin", file: id };
      case "deactivate": return { kind: "deactivate_plugin", file: id };
      case "delete": return { kind: "delete_plugin", file: id };
    }
  }
  switch (kind) {
    case "update": return { kind: "update_theme", slug: id };
    case "activate": return { kind: "activate_theme", slug: id };
    case "delete": return { kind: "delete_theme", slug: id };
    // Themes are switched, never deactivated; the UI never offers this.
    case "deactivate": throw new Error("Themes cannot be deactivated");
  }
}

/**
 * Partition a selection into what will run and what will be skipped, with a
 * reason for every exclusion. A bulk action never silently drops items.
 */
export function splitEligible(
  kind: BulkKind, target: BulkTarget, inv: InventoryPayload, ids: string[],
): BulkSplit {
  const split: BulkSplit = { included: [], excluded: [] };

  for (const id of ids) {
    if (target === "plugin") {
      const p = inv.plugins.find((x) => x.file === id);
      const label = p?.title || p?.name || id;
      if (!p) { split.excluded.push({ id, label, reason: "No longer installed." }); continue; }
      if (kind === "update" && p.update !== "available") {
        split.excluded.push({ id, label, reason: "Already up to date." }); continue;
      }
      if (kind === "activate" && p.status === "active") {
        split.excluded.push({ id, label, reason: "Already active." }); continue;
      }
      if (kind === "deactivate" && p.status !== "active") {
        split.excluded.push({ id, label, reason: "Already inactive." }); continue;
      }
      if (kind === "delete" && p.status === "active") {
        split.excluded.push({ id, label, reason: "This plugin is active. Deactivate it before deleting." }); continue;
      }
      split.included.push({ id, label });
      continue;
    }

    const t = inv.themes.find((x) => x.name === id);
    const label = t?.title || t?.name || id;
    if (!t) { split.excluded.push({ id, label, reason: "No longer installed." }); continue; }
    if (kind === "update" && t.update !== "available") {
      split.excluded.push({ id, label, reason: "Already up to date." }); continue;
    }
    if (kind === "activate" && t.status === "active") {
      split.excluded.push({ id, label, reason: "Already active." }); continue;
    }
    if (kind === "delete") {
      // Reuse the gate rather than restating it — one definition of "safe".
      const verdict = canDeleteTheme(inv.themes, id);
      if (!verdict.allowed) {
        split.excluded.push({ id, label, reason: verdict.reason }); continue;
      }
    }
    split.included.push({ id, label });
  }

  return split;
}

export interface BulkDeps { jobs: JobsRepo; sites: SitesRepo }

/** Enqueue one job per eligible item, all sharing a batch id. */
export async function enqueueBulk(
  deps: BulkDeps, siteId: string, actorId: string,
  kind: BulkKind, target: BulkTarget, inv: InventoryPayload, ids: string[],
): Promise<{ batchId: string | null; split: BulkSplit }> {
  const split = splitEligible(kind, target, inv, ids);
  if (split.included.length === 0) return { batchId: null, split };

  const batchId = crypto.randomUUID();
  for (const item of split.included) {
    // `actor` rides along in the payload (not part of the shared
    // BulkJobPayload contract the UI/API read) so the handler can attribute
    // the resulting manage-action activity log entry to whoever queued the
    // batch, the same way plugin_install payload carries its own actor.
    await deps.jobs.insert({
      type: "bulk_manage", site_id: siteId, batch_id: batchId,
      payload: { kind, target, id: item.id, label: item.label, actor: actorId },
    });
  }
  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: `site.bulk.${target}.${kind}`,
    detail: { queued: split.included.length, skipped: split.excluded.length },
  });
  return { batchId, split };
}
