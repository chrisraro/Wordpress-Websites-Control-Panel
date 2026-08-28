import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { processJobs, recoverStaleAwaiting } from "@/services/jobs/service";
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
  // Runs parked on a callback that never arrived rejoin the retry ladder.
  const stale = await recoverStaleAwaiting(jobsRepo, 30 * 60 * 1000);
  const result = await processJobs(jobsRepo, buildJobHandlers(db), { max: 3 });
  return NextResponse.json({ ok: true, stale, ...result });
}

export const POST = run;
export const GET = run;
