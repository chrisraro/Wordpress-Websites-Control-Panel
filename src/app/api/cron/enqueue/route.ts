import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { enqueueJob } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseSeoRepo } from "@/services/seo/repo";
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
  // Feed refresh first: claim_jobs processes by scheduled_for (insertion order),
  // so scans enqueued after it grade against tonight's feed, not yesterday's.
  const feedJob = await enqueueJob(jobs, "vuln_feed_refresh", null, {}, { dedupe: true });
  let enqueued = 0;
  for (const site of sites) {
    if (site.status === "disabled") continue;
    const res = await enqueueJob(jobs, "snapshot_refresh", site.id, {}, { dedupe: true });
    if (res) enqueued++;
  }
  let scans = 0;
  for (const site of sites) {
    if (site.status === "disabled") continue;
    const res = await enqueueJob(jobs, "security_scan", site.id, {}, { dedupe: true });
    if (res) scans++;
  }
  const seo = supabaseSeoRepo(db);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let seoScans = 0;
  for (const site of sites) {
    if (site.status === "disabled") continue;
    const last = await seo.lastRunAt(site.id);
    if (last && new Date(last).getTime() > weekAgo) continue;
    const res = await enqueueJob(jobs, "seo_scan", site.id, {}, { dedupe: true });
    if (res) seoScans++;
  }
  return NextResponse.json({ ok: true, sites: sites.length, enqueued, scans, seo: seoScans, feed: Boolean(feedJob) });
}

export const POST = run;
export const GET = run;
