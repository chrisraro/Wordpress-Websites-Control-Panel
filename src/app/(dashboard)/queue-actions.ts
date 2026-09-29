"use server";

import { revalidatePath } from "next/cache";
import { processJobs, recoverStaleAwaiting } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { buildJobHandlers } from "@/services/jobs/handlers";
import {
  cancellableIds, manageableBatchJobs, retryableIds, retryFailedJobs,
} from "@/services/jobs/batch-scope";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, isDenied } from "@/lib/authz/server";
import { friendlySiteError } from "@/lib/mcp/errors";

const ROUNDS = 5;          // up to 15 jobs per click
const BUDGET_MS = 120_000; // stay well inside the route's duration limit
/** Not found, not forbidden: a batch with no job on a site the viewer can
 *  manage must not confirm that the batch id exists. */
const BATCH_NOT_FOUND = "Batch not found.";

/**
 * Runs the job queue on demand. Local development has no scheduler, and a
 * deployment only gets one once pg_cron is wired, so every page that queues
 * work offers this rather than leaving jobs to sit.
 */
export async function processQueueNowAction(
  revalidate?: string,
): Promise<{
  ok: boolean; done?: number; failed?: number; retried?: number; claimed?: number; error?: string;
}> {
  await requireUser();
  const gate = await checkPermission("queue.process");
  if (isDenied(gate)) return gate;
  const started = Date.now();
  const totals = { claimed: 0, done: 0, failed: 0, retried: 0 };

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
      totals.retried += res.retried;
      if (res.claimed === 0) break;   // queue drained
    }
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Queue processing failed" };
  }

  if (revalidate) revalidatePath(revalidate);
  // A run where jobs failed is not a success, even though the queue itself
  // ran fine: reporting ok here would tell the operator their work landed.
  if (totals.failed > 0) {
    return { ok: false, ...totals, error: `${totals.failed} job(s) failed` };
  }
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

/**
 * Calls off the still-queued jobs in a batch.
 *
 * The batch page could previously only *accelerate* the queue. If a bulk
 * action went to the wrong site -- the exact scenario the environment work
 * exists to prevent -- the operator's only option was to watch it drain.
 *
 * Honest about its limits: only `pending` rows are stopped (see
 * JobsRepo.cancelJobs). A job already running is executing PHP on a live
 * install, and the count returned is what was actually stopped, so the UI
 * can say "3 of 8 stopped, the rest had already started" rather than
 * implying it undid the whole thing.
 */
export async function cancelBatchAction(
  batchId: string,
): Promise<{ ok: boolean; cancelled?: number; error?: string }> {
  await requireUser();
  const gate = await checkPermission("queue.process");
  if (isDenied(gate)) return gate;
  try {
    // Scoped to jobs on sites this viewer can manage -- never the whole
    // batch_id, which can span sites they have no grant for. Mirrors the MCP
    // cancel_batch tool (src/mcp/tools/jobs.ts).
    const repo = supabaseJobsRepo(createServiceSupabase());
    const scoped = manageableBatchJobs(gate, await repo.batchJobs(batchId));
    if (scoped.length === 0) return { ok: false, error: BATCH_NOT_FOUND };
    const cancelled = await repo.cancelJobs(cancellableIds(scoped));
    revalidatePath(`/marketplace/batches/${batchId}`);
    return { ok: true, cancelled };
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not cancel the batch" };
  }
}

/** Puts the failed jobs in a batch -- on sites the viewer can manage -- back on the queue. */
export async function retryBatchAction(
  batchId: string,
): Promise<{ ok: boolean; retried?: number; error?: string }> {
  await requireUser();
  const gate = await checkPermission("queue.process");
  if (isDenied(gate)) return gate;
  try {
    // Same site scoping as cancelBatchAction above.
    const db = createServiceSupabase();
    const scoped = manageableBatchJobs(gate, await supabaseJobsRepo(db).batchJobs(batchId));
    if (scoped.length === 0) return { ok: false, error: BATCH_NOT_FOUND };
    const retried = await retryFailedJobs(db, retryableIds(scoped));
    revalidatePath(`/marketplace/batches/${batchId}`);
    return { ok: true, retried };
  } catch (e) {
    return { ok: false, error: friendlySiteError(e) || "Could not retry the batch" };
  }
}
