import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { enqueueJob } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { supabaseReportsRepo } from "@/services/reports/repo";
import { REPORT_SECTIONS } from "@/services/reports/types";
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

  // Per-site work runs concurrently: each site needs 2-3 Supabase round trips and
  // this route has a 60s budget, so sequential loops would not scale with the fleet.
  const active = sites.filter((s) => s.status !== "disabled");
  const seo = supabaseSeoRepo(db);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  const perSite = await Promise.all(active.map(async (site) => {
    // snapshot_refresh must be inserted before security_scan: claim_jobs runs in
    // scheduled_for order, so the scan grades tonight's inventory, not yesterday's.
    const [snapshot, lastSeoRun] = await Promise.all([
      enqueueJob(jobs, "snapshot_refresh", site.id, {}, { dedupe: true }),
      seo.lastRunAt(site.id),
    ]);
    const scan = await enqueueJob(jobs, "security_scan", site.id, {}, { dedupe: true });
    const seoDue = !lastSeoRun || new Date(lastSeoRun).getTime() <= weekAgo;
    const seoJob = seoDue
      ? await enqueueJob(jobs, "seo_scan", site.id, {}, { dedupe: true })
      : null;

    // Monthly client report: only on the 1st, and only once per calendar month.
    let reportJob: { id: string } | null = null;
    const today = new Date();
    if (today.getUTCDate() === 1) {
      const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString();
      const already = await supabaseReportsRepo(db).autoExistsSince(site.id, monthStart);
      if (!already) {
        reportJob = await enqueueJob(jobs, "report_generate", site.id,
          { sections: REPORT_SECTIONS, period_days: 30 }, { dedupe: true });
      }
    }
    return { snapshot: Boolean(snapshot), scan: Boolean(scan), seo: Boolean(seoJob), report: Boolean(reportJob) };
  }));

  const enqueued = perSite.filter((r) => r.snapshot).length;
  const scans = perSite.filter((r) => r.scan).length;
  const seoScans = perSite.filter((r) => r.seo).length;
  const reports = perSite.filter((r) => r.report).length;
  return NextResponse.json({
    ok: true, sites: sites.length, enqueued, scans, seo: seoScans, reports, feed: Boolean(feedJob),
  });
}

export const POST = run;
export const GET = run;
