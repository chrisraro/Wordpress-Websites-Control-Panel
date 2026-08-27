"use server";

import { revalidatePath } from "next/cache";
import { manageSite } from "@/services/manage/service";
import type { ManageAction } from "@/services/manage/types";
import { refreshSnapshot } from "@/services/inventory/service";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

function revalidateSite(siteId: string) {
  for (const p of [`/sites/${siteId}`, `/sites/${siteId}/plugins`, `/sites/${siteId}/themes`, "/dashboard"]) {
    revalidatePath(p);
  }
}

export async function manageAction(
  siteId: string, action: ManageAction,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const db = createServiceSupabase();
  const result = await manageSite(
    { sites: supabaseSitesRepo(db), jobs: supabaseJobsRepo(db), mcp: createSiteMcpClient },
    siteId, user.id, action,
  );
  revalidateSite(siteId);
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}

export async function refreshInventoryAction(
  siteId: string,
): Promise<{ ok: boolean; error?: string }> {
  await requireUser();
  const db = createServiceSupabase();
  try {
    await refreshSnapshot(
      { sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db), mcp: createSiteMcpClient },
      siteId,
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Refresh failed" };
  }
  revalidateSite(siteId);
  return { ok: true };
}
