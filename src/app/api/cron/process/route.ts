import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { processJobs, type JobHandlers } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { refreshSnapshot } from "@/services/inventory/service";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { securityScan, refreshVulnFeed } from "@/services/security/scan";
import { supabaseSecurityRepo } from "@/services/security/repo";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceSupabase();
  const handlers: JobHandlers = {
    snapshot_refresh: async ({ job }) => {
      if (!job.site_id) throw new Error("snapshot_refresh requires site_id");
      await refreshSnapshot(
        { sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db), mcp: createSiteMcpClient },
        job.site_id,
      );
    },
    security_scan: async ({ job }) => {
      if (!job.site_id) throw new Error("security_scan requires site_id");
      await securityScan(
        {
          sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db),
          security: supabaseSecurityRepo(db), mcp: createSiteMcpClient,
        },
        job.site_id,
      );
    },
    vuln_feed_refresh: async () => {
      await refreshVulnFeed(supabaseSecurityRepo(db));
    },
  };
  const result = await processJobs(supabaseJobsRepo(db), handlers, { max: 3 });
  return NextResponse.json({ ok: true, ...result });
}

export const POST = run;
export const GET = run;
