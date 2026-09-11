"use server";

import { revalidatePath } from "next/cache";
import { securityScan } from "@/services/security/scan";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseAdminUsersRepo, supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";
import { friendlySiteError } from "@/lib/mcp/errors";
import { hardenSite, hardeningPlan, summarizeHardening } from "@/services/security/harden";

export async function runSecurityScanAction(
  siteId: string,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("security.run");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId);
  if (isDenied(site)) return site;
  const db = createServiceSupabase();
  try {
    await securityScan(
      {
        sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db),
        adminUsers: supabaseAdminUsersRepo(db),
        security: supabaseSecurityRepo(db), mcp: createSiteMcpClient,
      },
      siteId,
    );
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.security_scan", detail: { manual: true },
    });
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Scan failed" };
  }
  revalidatePath(`/sites/${siteId}/security`);
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Applies every hardening fix the latest scan calls for, then rescans.
 *
 * Gated like a write to a live site, not like a scan: wp_toolkit.manage plus a
 * per-site manage grant, the same pair every plugin update requires. It writes
 * files into wp-content, and security.run only entitles someone to look.
 *
 * The plan is recomputed from the latest checks here rather than taken from
 * the form. What the button showed and what runs are then the same list by
 * construction, and nothing in the browser can add a fix to it.
 */
export async function hardenSiteAction(
  siteId: string,
  _prevState?: { ok: boolean; message?: string; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;

  const db = createServiceSupabase();
  const security = supabaseSecurityRepo(db);
  const latest = await security.latestChecks(siteId);
  if (!latest) return { ok: false, error: "Run a security scan first, so there is something to act on." };
  const plan = hardeningPlan(latest.checks);
  if (plan.length === 0) return { ok: true, message: "Nothing to harden — every fixable check already passes." };

  const out = await hardenSite({ sites: supabaseSitesRepo(db), mcp: createSiteMcpClient }, siteId, user.id, plan);
  if (out.error && out.results.length === 0) {
    return { ok: false, error: friendlySiteError(new Error(out.error)) || out.error };
  }

  // Grades are computed by the scanner; re-run it so the page reflects the
  // new state instead of waiting for 02:00.
  try {
    await securityScan(
      {
        sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db),
        adminUsers: supabaseAdminUsersRepo(db), security, mcp: createSiteMcpClient,
      },
      siteId,
    );
  } catch { /* the hardening result is still worth reporting */ }
  revalidatePath(`/sites/${siteId}/security`);
  revalidatePath("/dashboard");
  return { ok: out.ok, ...summarizeHardening(out) };
}
