"use server";

import { revalidatePath } from "next/cache";
import { processJobs, recoverStaleAwaiting } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { buildJobHandlers } from "@/services/jobs/handlers";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, isDenied } from "@/lib/authz/server";

const ROUNDS = 5;          // up to 15 jobs per click
const BUDGET_MS = 120_000; // stay well inside the route's duration limit

/**
 * Runs the job queue on demand. Local development has no scheduler, and a
 * deployment only gets one once pg_cron is wired, so every page that queues
 * work offers this rather than leaving jobs to sit.
 */
export async function processQueueNowAction(
  revalidate?: string,
): Promise<{ ok: boolean; done?: number; failed?: number; claimed?: number; error?: string }> {
  await requireUser();
  const gate = await checkPermission("queue.process");
  if (isDenied(gate)) return gate;
  const started = Date.now();
  const totals = { claimed: 0, done: 0, failed: 0 };

  try {
    const db = createServiceSupabase();
    const repo = supabaseJobsRepo(db);
    const handlers = buildJobHandlers(db);
    await recoverStaleAwaiting(repo, 30 * 60 * 1000);
    for (let round = 0; round < ROUNDS; round++) {
      if (Date.now() - started > BUDGET_MS) break;
      const res = await processJobs(repo, handlers, { max: 3 });
      totals.claimed += res.claimed;
      totals.done += res.done;
      totals.failed += res.failed;
      if (res.claimed === 0) break;   // queue drained
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Queue processing failed" };
  }

  if (revalidate) revalidatePath(revalidate);
  return { ok: true, ...totals };
}

/**
 * Form-shaped wrapper for the same work. processQueueNowAction stays callable
 * directly (the batch poller does), while this one carries the
 * (…bound, prevState, formData) signature useActionState passes.
 */
export async function drainQueueAction(
  revalidate: string,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const res = await processQueueNowAction(revalidate);
  if (!res.ok) return { ok: false, error: res.error ?? "Queue processing failed" };
  return { ok: true };
}
