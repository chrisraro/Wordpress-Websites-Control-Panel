"use server";

import { revalidatePath } from "next/cache";
import { createChildTheme } from "@/services/childtheme/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, checkSiteAccess, isDenied } from "@/lib/authz/server";

export async function createChildThemeAction(
  siteId: string,
  activate: boolean,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;
  const db = createServiceSupabase();
  const result = await createChildTheme(
    { sites: supabaseSitesRepo(db), jobs: supabaseJobsRepo(db), mcp: createSiteMcpClient },
    siteId, user.id, activate,
  );
  revalidatePath(`/sites/${siteId}/themes`);
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}
