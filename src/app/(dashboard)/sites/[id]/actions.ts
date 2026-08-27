"use server";

import { revalidatePath } from "next/cache";
import { testSiteConnection } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

export async function runConnectionTest(siteId: string): Promise<void> {
  const user = await requireUser();
  const repo = supabaseSitesRepo(createServiceSupabase());
  await testSiteConnection({ repo, mcp: createSiteMcpClient }, siteId, user.id);
  revalidatePath(`/sites/${siteId}`);
}
