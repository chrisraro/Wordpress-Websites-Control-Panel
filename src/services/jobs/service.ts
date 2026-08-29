import { randomUUID } from "node:crypto";
import type { JobsRepo } from "./repo";
import type { JobRow, JobType } from "./types";

export interface JobContext { job: JobRow }
export type JobHandler = (ctx: JobContext) => Promise<void | { awaitingCallback: true }>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

/**
 * Thrown by a job handler to signal that the failure is not worth retrying —
 * e.g. an upstream rate limit whose reset window is measured in hours, far
 * longer than the retry ladder's ~6 minutes of total backoff. processJobs
 * sends this straight to `markFailed` without consuming a ladder attempt, so
 * quota isn't burned on retries that cannot succeed and the next legitimate
 * attempt (tomorrow's run, or after the window clears) still has its full
 * three attempts available.
 *
 * Keep this narrow and explicit: every job type flows through processJobs,
 * so an error must opt in by type (the `instanceof` check below, not
 * `e.name`) to skip the ladder. Anything else — a
 * plain Error, a thrown string, whatever a handler happens to throw — keeps
 * today's retry-then-fail behaviour unchanged.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

export function computeRetryDelayMs(attemptsAfterClaim: number): number | null {
  if (attemptsAfterClaim <= 1) return 60_000;
  if (attemptsAfterClaim === 2) return 300_000;
  return null;
}

export async function enqueueJob(
  repo: JobsRepo, type: JobType, siteId: string | null,
  payload: Record<string, unknown> = {}, opts: { dedupe?: boolean } = {},
): Promise<{ id: string } | null> {
  if (opts.dedupe && (await repo.pendingExists(type, siteId))) return null;
  return repo.insert({ type, site_id: siteId, payload });
}

/**
 * Jobs parked on a callback that never arrived go back through the normal
 * retry ladder, and only exhaust to `failed` like any other failure.
 */
export async function recoverStaleAwaiting(
  repo: JobsRepo, olderThanMs: number,
): Promise<{ retried: number; failed: number }> {
  const stale = await repo.listStaleAwaiting(olderThanMs);
  const out = { retried: 0, failed: 0 };
  for (const job of stale) {
    const delay = computeRetryDelayMs(job.attempts);
    if (delay === null) {
      await repo.markFailed(job.id, "Callback never arrived");
      out.failed++;
    } else {
      await repo.retry(job.id, "Callback never arrived", new Date(Date.now() + delay).toISOString());
      out.retried++;
    }
  }
  return out;
}

export async function processJobs(
  repo: JobsRepo, handlers: JobHandlers, opts: { max?: number } = {},
): Promise<{ claimed: number; done: number; failed: number; retried: number; awaiting: number }> {
  const jobs = await repo.claim(opts.max ?? 3);
  const result = { claimed: jobs.length, done: 0, failed: 0, retried: 0, awaiting: 0 };
  for (const job of jobs) {
    const handler = handlers[job.type];
    if (!handler) {
      await repo.markFailed(job.id, `no handler registered for job type "${job.type}"`);
      result.failed++;
      continue;
    }
    try {
      const outcome = await handler({ job });
      if (outcome && typeof outcome === "object" && outcome.awaitingCallback) {
        await repo.markAwaiting(job.id);
        result.awaiting++;
      } else {
        await repo.markDone(job.id);
        result.done++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof NonRetryableError) {
        await repo.markFailed(job.id, msg);
        result.failed++;
        continue;
      }
      const delay = computeRetryDelayMs(job.attempts);
      if (delay === null) {
        await repo.markFailed(job.id, msg);
        result.failed++;
      } else {
        await repo.retry(job.id, msg, new Date(Date.now() + delay).toISOString());
        result.retried++;
      }
    }
  }
  return result;
}

export async function enqueueBatch(
  repo: JobsRepo, type: JobType, siteIds: string[], payload: Record<string, unknown>,
): Promise<{ batchId: string; count: number }> {
  if (siteIds.length === 0) throw new Error("Select at least one site");
  const batchId = randomUUID();
  for (const siteId of siteIds) {
    await repo.insert({ type, site_id: siteId, payload, batch_id: batchId });
  }
  return { batchId, count: siteIds.length };
}
