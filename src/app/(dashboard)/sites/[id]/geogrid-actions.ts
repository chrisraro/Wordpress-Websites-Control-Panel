"use server";

import { revalidatePath } from "next/cache";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { parseGeoGridConfigForm } from "@/services/geogrid/config-input";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";
import { friendlySiteError } from "@/lib/mcp/errors";

/**
 * useActionState calls the action as (prevState, formData); binding siteId puts
 * it first, so the previous state must be accepted here or formData lands in
 * the wrong parameter.
 */
export async function saveGeoGridConfigAction(
  siteId: string,
  _prevState: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("geogrid.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId);
  if (isDenied(site)) return site;
  const parsed = parseGeoGridConfigForm(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const db = createServiceSupabase();
  try {
    await supabaseGeoGridRepo(db).upsertConfig(siteId, parsed.value);
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.geogrid_config",
      detail: {
        keywords: parsed.value.keywords.length,
        grid_size: parsed.value.grid_size,
        provider: parsed.value.provider,
      },
    });
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not save configuration" };
  }
  revalidatePath(`/sites/${siteId}/geogrid`);
  return { ok: true };
}

export async function runGeoGridAction(
  siteId: string,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string; queued?: number }> {
  const user = await requireUser();
  const gate = await checkPermission("geogrid.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId);
  if (isDenied(site)) return site;
  const db = createServiceSupabase();
  const config = await supabaseGeoGridRepo(db).getConfigBySite(siteId);
  if (!config) return { ok: false, error: "Save a GeoGrid configuration first" };
  if (config.keywords.length === 0) return { ok: false, error: "Add at least one keyword" };

  try {
    const jobs = supabaseJobsRepo(db);
    const batchId = crypto.randomUUID();
    for (const keyword of config.keywords) {
      await jobs.insert({
        type: "geogrid_run", site_id: siteId, batch_id: batchId,
        payload: { config_id: config.id, keyword },
      });
    }
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.geogrid_run",
      detail: { keywords: config.keywords.length, provider: config.provider },
    });
    revalidatePath(`/sites/${siteId}/geogrid`);
    return { ok: true, queued: config.keywords.length };
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not queue the run" };
  }
}

/**
 * Clears the "N failed" alert on the GeoGrid page. This dismisses only —
 * the job rows and their `last_error` stay exactly as they are, so a
 * resolved failure can stop nagging without losing the record of what
 * happened.
 */
export async function dismissFailedGeoGridRunsAction(
  siteId: string,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("geogrid.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId);
  if (isDenied(site)) return site;
  const db = createServiceSupabase();
  try {
    await supabaseJobsRepo(db).dismissFailed(siteId, "geogrid_run");
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.geogrid_dismiss_failed",
    });
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not dismiss the failed runs" };
  }
  revalidatePath(`/sites/${siteId}/geogrid`);
  return { ok: true };
}
