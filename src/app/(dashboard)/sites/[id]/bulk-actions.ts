"use server";

import { revalidatePath } from "next/cache";
import { enqueueBulk } from "@/services/bulk/service";
import type { BulkKind, BulkScope, BulkTarget } from "@/services/bulk/types";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";
import { friendlySiteError } from "@/lib/mcp/errors";
import { supabaseMaintenanceRepo } from "@/services/maintenance/repo";
import { planTiming, type Timing } from "@/services/maintenance/schedule";
import type { BackupPolicy } from "@/services/backup/updraft";

/**
 * `opts.timing === "window"` holds the batch until this site's next
 * maintenance window (0027); a site with no window, or whose window is open
 * right now, runs now either way.
 *
 * `opts.backup === "skip"` is "Update without a backup" from the dialog;
 * anything else (including omitted) keeps the pre-update backup. Only
 * updates carry it -- the backup gate never runs for activate/delete.
 */
export async function bulkAction(
  siteId: string, kind: BulkKind, target: BulkTarget, ids: string[],
  opts: { timing?: Timing; backup?: BackupPolicy } = {},
): Promise<{
  ok: boolean; batchId?: string; queued?: number; skipped?: number; error?: string;
  /** Set when the batch waits for the maintenance window. */
  scheduledFor?: string;
}> {
  const user = await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;
  if (ids.length === 0) return { ok: false, error: "Nothing selected" };
  if (ids.length > 50) return { ok: false, error: "Select 50 items or fewer" };

  const db = createServiceSupabase();
  // Eligibility is judged against the stored snapshot, which is what the user
  // was looking at. Each job re-checks against live state when it runs.
  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(siteId);
  if (!snapshot) return { ok: false, error: "Refresh the inventory first" };

  try {
    const scope: BulkScope = target === "plugin"
      ? { target: "plugin", plugins: snapshot.payload.plugins }
      : { target: "theme", themes: snapshot.payload.themes };
    // Anything but the literal "window" runs now (see parseTiming).
    const timing: Timing = opts.timing === "window" ? "window" : "now";
    const { scheduledFor } = await planTiming(
      supabaseMaintenanceRepo(db), [siteId], timing, new Date(),
    );
    const at = scheduledFor.get(siteId);
    // Same rule as parseBackupChoice: only the literal "skip" drops it.
    const skipBackup = kind === "update" && opts.backup === "skip";
    const { batchId, split } = await enqueueBulk(
      { jobs: supabaseJobsRepo(db), sites: supabaseSitesRepo(db) },
      siteId, user.id, kind, scope, ids,
      { ...(at ? { scheduledFor: at } : {}), ...(skipBackup ? { backup: "skip" as const } : {}) },
    );
    revalidatePath(`/sites/${siteId}/${target === "plugin" ? "plugins" : "themes"}`);
    if (!batchId) {
      return { ok: false, error: `Nothing eligible — ${split.excluded[0]?.reason ?? "all items skipped"}` };
    }
    return {
      ok: true, batchId, queued: split.included.length, skipped: split.excluded.length,
      ...(at ? { scheduledFor: at } : {}),
    };
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not queue the bulk action" };
  }
}
