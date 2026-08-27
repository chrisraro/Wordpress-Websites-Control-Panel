import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { enqueueJob } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceSupabase();
  const sites = await supabaseSitesRepo(db).listSites();
  const jobs = supabaseJobsRepo(db);
  let enqueued = 0;
  for (const site of sites) {
    if (site.status === "disabled") continue;
    const res = await enqueueJob(jobs, "snapshot_refresh", site.id, {}, { dedupe: true });
    if (res) enqueued++;
  }
  return NextResponse.json({ ok: true, sites: sites.length, enqueued });
}

export const POST = run;
export const GET = run;
