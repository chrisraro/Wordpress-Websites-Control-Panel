import { randomUUID } from "node:crypto";
import type { JobsRepo, JobTransitionGuard } from "./repo";
import type { JobRow, JobStatus, JobType } from "./types";

/**
 * Every non-terminal job status. Shared by the GeoGrid page's "in progress"
 * banner (src/app/(dashboard)/sites/[id]/geogrid/page.tsx) and the run poller's
 * API route (src/app/api/sites/[id]/geogrid-runs/route.ts) so "is anything
 * open" can never be answered two different ways by two different call sites.
 */
const OPEN_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["pending", "running", "awaiting_callback"]);

export function isOpenJobStatus(status: JobStatus): boolean {
  return OPEN_JOB_STATUSES.has(status);
}

/**
 * True once every job in the list has reached a terminal status (done or
 * failed). Vacuously true for an empty list: no jobs at all means nothing is
 * left to watch, which is the same "stop polling" outcome as everything
 * having settled.
 */
export function allSettled(jobs: { status: JobStatus }[]): boolean {
  return jobs.every((j) => !isOpenJobStatus(j.status));
}

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
    // Guarded on awaiting_callback: the n8n callback can land between the
    // list above and this write, and must not be undone by it.
    const guard: JobTransitionGuard = { status: "awaiting_callback", attempts: job.attempts };
    const delay = computeRetryDelayMs(job.attempts);
    if (delay === null) {
      await repo.markFailed(job.id, "Callback never arrived", guard);
      out.failed++;
    } else {
      await repo.retry(job.id, "Callback never arrived", new Date(Date.now() + delay).toISOString(), guard);
      out.retried++;
    }
  }
  return out;
}

/**
 * Default wall-clock budget for starting new work in one invocation. The
 * cron route's maxDuration is 300s and a single handler can take most of
 * that, so a job is only claimed while the invocation is young enough to
 * plausibly finish it. Unclaimed jobs stay pending for the next minute's
 * run instead of being claimed (spending an attempt) and stranded.
 */
const DEFAULT_BUDGET_MS = 120_000;

type Outcome =
  | { kind: "done" } | { kind: "awaiting" }
  | { kind: "failed"; msg: string } | { kind: "retry"; msg: string; delayMs: number };

export async function processJobs(
  repo: JobsRepo, handlers: JobHandlers,
  opts: { max?: number; budgetMs?: number; now?: () => number } = {},
): Promise<{ claimed: number; done: number; failed: number; retried: number; awaiting: number }> {
  const max = opts.max ?? 3;
  const now = opts.now ?? Date.now;
  const started = now();
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const result = { claimed: 0, done: 0, failed: 0, retried: 0, awaiting: 0 };

  // One claim per job, so nothing is claimed that this invocation will not run.
  while (result.claimed < max && now() - started < budget) {
    const [job] = await repo.claim(1);
    if (!job) break;
    result.claimed++;
    const outcome = await runHandler(handlers, job);
    result[outcome.kind === "retry" ? "retried" : outcome.kind]++;
    await settle(repo, job, outcome);
  }
  return result;
}

async function runHandler(handlers: JobHandlers, job: JobRow): Promise<Outcome> {
  const handler = handlers[job.type];
  if (!handler) return { kind: "failed", msg: `no handler registered for job type "${job.type}"` };
  try {
    const out = await handler({ job });
    return out && typeof out === "object" && out.awaitingCallback ? { kind: "awaiting" } : { kind: "done" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof NonRetryableError) return { kind: "failed", msg };
    const delayMs = computeRetryDelayMs(job.attempts);
    return delayMs === null ? { kind: "failed", msg } : { kind: "retry", msg, delayMs };
  }
}

/**
 * Records a handler's outcome. Deliberately outside the handler's try: if
 * this write fails after a successful install, treating it as a handler
 * failure would put the job back on the retry ladder and run it again on a
 * live site. A failed write is logged and the job left `running`; the SQL
 * stale reclaim (and its attempts cap) deals with it. One job's bookkeeping
 * failure never aborts the rest of the loop.
 */
async function settle(repo: JobsRepo, job: JobRow, outcome: Outcome): Promise<void> {
  const guard: JobTransitionGuard = { status: "running", attempts: job.attempts };
  try {
    switch (outcome.kind) {
      case "done": return await repo.markDone(job.id, guard);
      case "awaiting": return await repo.markAwaiting(job.id);
      case "failed": return await repo.markFailed(job.id, outcome.msg, guard);
      case "retry":
        return await repo.retry(job.id, outcome.msg, new Date(Date.now() + outcome.delayMs).toISOString(), guard);
    }
  } catch (e) {
    console.error(`jobs: could not record ${outcome.kind} for job ${job.id} (${job.type})`, e);
  }
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
