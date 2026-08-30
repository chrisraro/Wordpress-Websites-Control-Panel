"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { addSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, isDenied } from "@/lib/authz/server";
import { friendlySiteError } from "@/lib/mcp/errors";

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().url("Enter a full URL, e.g. https://example.com"),
  wpUsername: z.string().min(1, "WordPress username is required"),
  appPassword: z.string().min(8, "Application password looks too short"),
  clientLabel: z.string().optional(),
  // No default: an unanswered environment must fail the form rather than be
  // assumed. The radio group is `required`, so this only fires if the field
  // is missing entirely.
  environment: z.enum(["production", "staging"], {
    message: "Choose whether this is a production or staging site",
  }),
});

export async function createSite(_prev: { error?: string } | undefined, formData: FormData) {
  const user = await requireUser();
  const gate = await checkPermission("sites.manage");
  if (isDenied(gate)) return gate;
  const parsed = schema.safeParse({
    name: formData.get("name"),
    url: formData.get("url"),
    wpUsername: formData.get("wpUsername"),
    appPassword: formData.get("appPassword"),
    clientLabel: formData.get("clientLabel") || undefined,
    environment: formData.get("environment"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const db = createServiceSupabase();
  const repo = supabaseSitesRepo(db);
  let id: string;
  try {
    ({ id } = await addSite({ repo, mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) }, parsed.data, user.id));
  } catch (e) {
    return { error: friendlySiteError(e) || "Failed to connect site" };
  }
  redirect(`/sites/${id}`);
}
