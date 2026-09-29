"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { startBackup } from "@/services/backup/gate";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";
import { friendlySiteError } from "@/lib/mcp/errors";

const SiteId = z.uuid();

type Result = { ok: boolean; error?: string; message?: string };

/**
 * "Back up now" on a site's overview: asks the site's own UpdraftPlus to run
 * a backup (startBackup). It is scheduled on WP-Cron and runs in the site's
 * PHP, so this returns as soon as the request is accepted -- the result shows
 * up in the next inventory refresh, not here.
 *
 * wp_toolkit.manage plus a `manage` grant, like every other action that runs
 * code on the site (manageAction, refreshInventoryAction).
 */
export async function backupNowAction(
  siteId: string,
  _prevState?: Result | null,
  _formData?: FormData,
): Promise<Result> {
  const user = await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const parsed = SiteId.safeParse(siteId);
  if (!parsed.success) return { ok: false, error: "That site could not be found." };
  const site = await checkSiteAccess(parsed.data, "manage");
  if (isDenied(site)) return site;

  const db = createServiceSupabase();
  const sites = supabaseSitesRepo(db);
  try {
    await startBackup({ sites, mcp: createSiteMcpClient }, parsed.data);
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not start the backup." };
  }
  try {
    await sites.insertActivity({
      actor: user.id, site_id: parsed.data, action: "site.backup.request",
      detail: { plugin: "updraftplus" },
    });
  } catch (e) {
    // The backup is already running; a failed log write must not report
    // failure and invite a second backup.
    console.error(`[backup] could not log the backup request for ${parsed.data}:`, e);
  }
  revalidatePath(`/sites/${parsed.data}`);
  return {
    ok: true,
    message: "Backup started. UpdraftPlus runs it in the background; refresh the inventory later to see it.",
  };
}
