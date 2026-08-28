import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { processJobs } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { buildJobHandlers } from "@/services/jobs/handlers";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceSupabase();
  const jobsRepo = supabaseJobsRepo(db);
  // Runs parked waiting on an n8n callback that never arrived are failed so
  // their normal retry/backoff can take over.
  const stale = await jobsRepo.failStaleAwaiting(30 * 60 * 1000);
  const result = await processJobs(jobsRepo, buildJobHandlers(db), { max: 3 });
  return NextResponse.json({ ok: true, stale, ...result });
}

export const POST = run;
export const GET = run;
