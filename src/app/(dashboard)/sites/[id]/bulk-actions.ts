"use server";

import { revalidatePath } from "next/cache";
import { enqueueBulk } from "@/services/bulk/service";
import type { BulkKind, BulkScope, BulkTarget } from "@/services/bulk/types";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";

export async function bulkAction(
  siteId: string, kind: BulkKind, target: BulkTarget, ids: string[],
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; batchId?: string; queued?: number; skipped?: number; error?: string }> {
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
    const { batchId, split } = await enqueueBulk(
      { jobs: supabaseJobsRepo(db), sites: supabaseSitesRepo(db) },
      siteId, user.id, kind, scope, ids,
    );
    revalidatePath(`/sites/${siteId}/${target === "plugin" ? "plugins" : "themes"}`);
    if (!batchId) {
      return { ok: false, error: `Nothing eligible — ${split.excluded[0]?.reason ?? "all items skipped"}` };
    }
    return { ok: true, batchId, queued: split.included.length, skipped: split.excluded.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not queue the bulk action" };
  }
}
