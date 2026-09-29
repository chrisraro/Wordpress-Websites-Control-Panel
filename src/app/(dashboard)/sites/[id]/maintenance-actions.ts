"use server";

import { revalidatePath } from "next/cache";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseMaintenanceRepo } from "@/services/maintenance/repo";
import { parseWindowForm } from "@/services/maintenance/window";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";

type Result = { ok: boolean; error?: string };

/**
 * Sets or clears a site's maintenance window (0027_site_maintenance_window.sql).
 *
 * sites.manage plus a `manage` grant, like every other edit to the site
 * record (environment, origin override, pairing). Validated by
 * parseWindowForm (zod + an Intl check of the zone) before anything is
 * written; the database's check constraint is the backstop.
 */
export async function setMaintenanceWindowAction(
  siteId: string,
  _prevState?: Result | null,
  formData?: FormData,
): Promise<Result> {
  const user = await requireUser();
  const gate = await checkPermission("sites.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;

  const parsed = parseWindowForm(formData ?? new FormData());
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const db = createServiceSupabase();
  try {
    await supabaseMaintenanceRepo(db).setWindow(siteId, parsed.window);
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.maintenance_window",
      detail: { window: parsed.window },
    });
    revalidatePath(`/sites/${siteId}`);
    return { ok: true };
  } catch (e) {
    console.error(`[sites] could not save the maintenance window for ${siteId}:`, e);
    return { ok: false, error: "Could not save the maintenance window." };
  }
}
