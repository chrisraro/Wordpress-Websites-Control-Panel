import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "invalid batch id" }, { status: 400 });
  }
  const db = createServiceSupabase();
  const [jobs, sites] = await Promise.all([
    supabaseJobsRepo(db).batchJobs(id),
    supabaseSitesRepo(db).listSites(),
  ]);
  const names = new Map(sites.map((s) => [s.id, s.name]));
  const rows = jobs.map((j) => {
    const siteName = j.site_id ? names.get(j.site_id) ?? j.site_id : "—";
    const payloadLabel = (j.payload as { label?: unknown }).label;
    return {
      id: j.id,
      site_id: j.site_id,
      site_name: siteName,
      // Bulk batches are one site, many items; install batches are one item,
      // many sites. The payload label distinguishes them.
      label: typeof payloadLabel === "string" && payloadLabel ? payloadLabel : siteName,
      status: j.status,
      attempts: j.attempts,
      last_error: j.last_error,
    };
  });
  const done = rows.length > 0 && rows.every((r) => r.status === "done" || r.status === "failed");
  return NextResponse.json({ jobs: rows, done });
}
