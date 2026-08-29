"use server";

import { revalidatePath } from "next/cache";
import { securityScan } from "@/services/security/scan";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseAdminUsersRepo, supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";

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
    return { ok: false, error: e instanceof Error ? e.message : "Scan failed" };
  }
  revalidatePath(`/sites/${siteId}/security`);
  revalidatePath("/dashboard");
  return { ok: true };
}
