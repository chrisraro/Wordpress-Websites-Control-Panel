"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { addSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().url("Enter a full URL, e.g. https://example.com"),
  wpUsername: z.string().min(1, "WordPress username is required"),
  appPassword: z.string().min(8, "Application password looks too short"),
  clientLabel: z.string().optional(),
});

export async function createSite(_prev: { error?: string } | undefined, formData: FormData) {
  const user = await requireUser();
  const parsed = schema.safeParse({
    name: formData.get("name"),
    url: formData.get("url"),
    wpUsername: formData.get("wpUsername"),
    appPassword: formData.get("appPassword"),
    clientLabel: formData.get("clientLabel") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const repo = supabaseSitesRepo(createServiceSupabase());
  let id: string;
  try {
    ({ id } = await addSite({ repo, mcp: createSiteMcpClient }, parsed.data, user.id));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to connect site" };
  }
  redirect(`/sites/${id}`);
}
