"use server";

import { revalidatePath } from "next/cache";
import { seoScan } from "@/services/seo/scan";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";

export async function runSeoScanAction(
  siteId: string,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("seo.run");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId);
  if (isDenied(site)) return site;
  const db = createServiceSupabase();
  try {
    await seoScan(
      { sites: supabaseSitesRepo(db), seo: supabaseSeoRepo(db), mcp: createSiteMcpClient },
      siteId,
    );
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.seo_scan", detail: { manual: true },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "SEO scan failed" };
  }
  revalidatePath(`/sites/${siteId}/seo`);
  revalidatePath("/dashboard");
  return { ok: true };
}
