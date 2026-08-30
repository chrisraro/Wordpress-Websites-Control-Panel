"use server";

import { revalidatePath } from "next/cache";
import { manageSite } from "@/services/manage/service";
import type { ManageAction } from "@/services/manage/types";
import { refreshSnapshot } from "@/services/inventory/service";
import { supabaseAdminUsersRepo, supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";
import { friendlySiteError } from "@/lib/mcp/errors";
import type { SiteEnvironment } from "@/services/sites/types";

function revalidateSite(siteId: string) {
  for (const p of [`/sites/${siteId}`, `/sites/${siteId}/plugins`, `/sites/${siteId}/themes`, "/dashboard"]) {
    revalidatePath(p);
  }
}

export async function manageAction(
  siteId: string,
  action: ManageAction,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;
  const db = createServiceSupabase();
  try {
    const result = await manageSite(
      { sites: supabaseSitesRepo(db), jobs: supabaseJobsRepo(db), mcp: createSiteMcpClient },
      siteId, user.id, action,
    );
    revalidateSite(siteId);
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
  } catch (e) {
    revalidateSite(siteId);
    return { ok: false, error: friendlySiteError(e) || "Action failed" };
  }
}

export async function refreshInventoryAction(
  siteId: string,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  await requireUser();
  // A site grant says which sites; a permission says what may be done on
  // them. This is the one WP Toolkit write in the codebase that used to
  // check only the former -- every sibling action (manageAction above,
  // bulkAction, installThemeAction, ...) requires both. Without this, a
  // `manage` grant alone -- the level a client's own dashboard offers, see
  // site-grants.tsx -- opens an MCP connection and runs PHP on the site's
  // live WordPress install.
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;
  const db = createServiceSupabase();
  try {
    await refreshSnapshot(
      {
        sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db),
        adminUsers: supabaseAdminUsersRepo(db), mcp: createSiteMcpClient,
      },
      siteId,
    );
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Refresh failed" };
  }
  revalidateSite(siteId);
  return { ok: true };
}

/**
 * Corrects a site's recorded environment.
 *
 * The connect form asks, but a site imported in bulk got the regex's answer
 * (scripts/import-novamira-sites.ts) and the twelve existing rows were
 * backfilled by 0017 the same way. Both can be wrong, and a wrong answer here
 * is the one PRODUCT.md calls expensive -- so it has to be correctable
 * without a database console.
 *
 * Gated on sites.manage rather than wp_toolkit.manage: this edits the site
 * record itself, not the WordPress install, and it is the same permission the
 * connect form requires to set the value in the first place.
 */
export async function setEnvironmentAction(
  siteId: string,
  environment: SiteEnvironment,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("sites.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;
  const db = createServiceSupabase();
  try {
    const sites = supabaseSitesRepo(db);
    await sites.setSiteEnvironment(siteId, environment);
    // Logged because it changes how every later confirmation reads. If a
    // destructive action is later run against the wrong environment, this row
    // is how you find out when the label changed and who changed it.
    await sites.insertActivity({
      actor: user.id, site_id: siteId, action: "site.environment",
      detail: { environment },
    });
    revalidateSite(siteId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not change the environment" };
  }
}
