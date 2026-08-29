"use server";

import { revalidatePath } from "next/cache";
import { testSiteConnection } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";
import type { SiteStatus } from "@/services/sites/types";

export async function runConnectionTest(
  siteId: string,
): Promise<{ ok: boolean; status: SiteStatus; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("sites.manage");
  if (isDenied(gate)) return { ok: false, status: "disabled", error: gate.error };
  const site = await checkSiteAccess(siteId);
  if (isDenied(site)) return { ok: false, status: "disabled", error: site.error };
  const repo = supabaseSitesRepo(createServiceSupabase());
  const result = await testSiteConnection({ repo, mcp: createSiteMcpClient }, siteId, user.id);
  revalidatePath(`/sites/${siteId}`);
  return result;
}

/**
 * useActionState calls (prevState, formData); the bound siteId is prepended,
 * so this signature must carry all three. Declaring it any other way and
 * casting at the call site is what crashed the GeoGrid form.
 */
export async function testConnectionAction(
  siteId: string,
  _prevState: { ok: boolean; error?: string } | null,
  _formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const result = await runConnectionTest(siteId);
  return result.ok
    ? { ok: true }
    : { ok: false, error: result.error ?? `Site reported status: ${result.status}` };
}
