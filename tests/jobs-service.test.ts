import { describe, it, expect } from "vitest";
import {
  allSettled, computeRetryDelayMs, enqueueJob, isOpenJobStatus, processJobs,
  recoverStaleAwaiting, NonRetryableError, DeferJob,
} from "@/services/jobs/service";
import type { JobsRepo, JobTransitionGuard } from "@/services/jobs/repo";
import type { JobRow, JobType } from "@/services/jobs/types";

/** Mirrors the SQL guard: `.eq("status", g.status).eq("attempts", g.attempts)`. */
function matches(r: JobRow, guard?: JobTransitionGuard) {
  return !guard || (r.status === guard.status && r.attempts === guard.attempts);
}

function memoryJobsRepo() {
  const rows: JobRow[] = [];
  let seq = 0;
  const repo: JobsRepo = {
    async insert(job) {
      const id = `job-${++seq}`;
      rows.push({
        id, type: job.type, site_id: job.site_id ?? null, batch_id: null,
        payload: job.payload ?? {}, status: "pending", attempts: 0,
        scheduled_for: job.scheduled_for ?? new Date(0).toISOString(), last_error: null,
        dismissed_at: null, finished_at: null,
      });
      return { id };
    },
    async pendingExists(type: JobType, siteId: string | null) {
      return rows.some((r) => r.type === type && r.site_id === siteId && !r.cancelled_at
        && (r.status === "pending" || r.status === "running" || r.status === "awaiting_callback"));
    },
    async claim(n) {
      // Mirrors claim_jobs: only due, uncancelled pending rows.
      const now = new Date().toISOString();
      const due = rows.filter((r) => r.status === "pending" && !r.cancelled_at && r.scheduled_for <= now)
        .slice(0, n);
      due.forEach((r) => { r.status = "running"; r.attempts += 1; });
      return due.map((r) => ({ ...r }));
    },
    async markDone(id, guard) {
      const r = rows.find((x) => x.id === id)!;
      if (!matches(r, guard)) return;
      r.status = "done";
    },
    async retry(id, error, retryAtIso, guard) {
      const r = rows.find((x) => x.id === id)!;
      if (!matches(r, guard)) return;
      r.status = "pending"; r.last_error = error; r.scheduled_for = retryAtIso;
      // Mirrors JobsRepo.retry (src/services/jobs/repo.ts): a job going back
      // on the ladder must not stay dismissed, so it can reappear in the
      // failed-runs alert if it fails again.
      r.dismissed_at = null;
    },
    async markFailed(id, error, guard) {
      const r = rows.find((x) => x.id === id)!;
      if (!matches(r, guard)) return;
      r.status = "failed"; r.last_error = error;
    },
    async defer(id, retryAtIso, payload, guard) {
      const r = rows.find((x) => x.id === id)!;
      if (!matches(r, guard)) return;
      r.status = "pending"; r.scheduled_for = retryAtIso; r.payload = payload;
      r.attempts = guard.attempts - 1;
    },
    async batchJobs(batchId) {
      return rows.filter((r) => r.batch_id === batchId);
    },
    async markAwaiting(id) { rows.find((r) => r.id === id)!.status = "awaiting_callback"; },
    async getJob(id) { return rows.find((r) => r.id === id) ?? null; },
    async listStaleAwaiting() { return rows.filter((r) => r.status === "awaiting_callback"); },
    async listGlobalFailures() {
      return rows.filter((r) => r.site_id === null && r.status === "failed" && !r.dismissed_at);
    },
    async listJobs(filter) {
      let out = rows;
      if (filter.siteIds !== null) out = out.filter((r) => r.site_id && filter.siteIds!.includes(r.site_id));
      if (filter.status) out = out.filter((r) => r.status === filter.status);
      return out
        .slice()
        .sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for))
        .slice(0, filter.limit);
    },
    async cancelBatch() { return 0; },
    async cancelJobs() { return 0; },
    async retryFailedInBatch() { return 0; },
    async dismissFailed(siteId, type) {
      rows
        .filter((r) => r.site_id === siteId && r.type === type && r.status === "failed")
        .forEach((r) => { r.dismissed_at = new Date().toISOString(); });
    },
  };
  return { repo, rows };
}

describe("computeRetryDelayMs", () => {
  it("backs off 60s then 300s then gives up", () => {
    expect(computeRetryDelayMs(1)).toBe(60_000);
    expect(computeRetryDelayMs(2)).toBe(300_000);
    expect(computeRetryDelayMs(3)).toBeNull();
    expect(computeRetryDelayMs(4)).toBeNull();
  });
});

describe("enqueueJob", () => {
  it("inserts a pending job", async () => {
    const { repo, rows } = memoryJobsRepo();
    const res = await enqueueJob(repo, "snapshot_refresh", "site-1");
    expect(res?.id).toBe("job-1");
    expect(rows[0]).toMatchObject({ type: "snapshot_refresh", site_id: "site-1", status: "pending" });
  });

  it("dedupes when a pending job of same type+site exists", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    const dup = await enqueueJob(repo, "snapshot_refresh", "site-1", {}, { dedupe: true });
    expect(dup).toBeNull();
    expect(rows).toHaveLength(1);
  });
});

describe("processJobs", () => {
  it("runs handler and marks done", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    const seen: string[] = [];
    const res = await processJobs(repo, {
      snapshot_refresh: async ({ job }) => { seen.push(job.site_id!); },
    });
    expect(seen).toEqual(["site-1"]);
    expect(res).toMatchObject({ claimed: 1, done: 1, failed: 0, retried: 0 });
    expect(rows[0].status).toBe("done");
  });

  it("retries on failure with backoff, fails permanently after 3 attempts", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    const boom = { snapshot_refresh: async () => { throw new Error("nope"); } };

    let res = await processJobs(repo, boom);
    expect(res.retried).toBe(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].last_error).toBe("nope");

    // The retry is scheduled in the future; bring it due, as time would.
    rows[0].scheduled_for = new Date(0).toISOString();
    res = await processJobs(repo, boom);
    expect(res.retried).toBe(1);

    rows[0].scheduled_for = new Date(0).toISOString();
    res = await processJobs(repo, boom);
    expect(res.failed).toBe(1);
    expect(rows[0].status).toBe("failed");
  });

  it("clears a prior dismissal when a job goes back on the retry ladder", async () => {
    // A `failed` job is dismissable and terminal today, so this path isn't
    // reachable yet in production — but JobsRepo.retry clears dismissed_at
    // unconditionally so a future `failed -> pending` retry can't resurrect
    // a job that was born dismissed. Model that here directly against the
    // fake rather than waiting on that future path to exist.
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    rows[0].dismissed_at = "2026-01-01T00:00:00Z";
    const boom = { snapshot_refresh: async () => { throw new Error("nope"); } };

    const res = await processJobs(repo, boom);
    expect(res.retried).toBe(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].dismissed_at).toBeNull();
  });

  it("fails a NonRetryableError immediately, without consuming a ladder attempt", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "vuln_feed_refresh", null);
    const rateLimited = {
      vuln_feed_refresh: async () => { throw new NonRetryableError("Wordfence feed rate limited: HTTP 429"); },
    };
    const res = await processJobs(repo, rateLimited);
    expect(res).toMatchObject({ claimed: 1, done: 0, failed: 1, retried: 0 });
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toBe("Wordfence feed rate limited: HTTP 429");
    // Only the one claim attempt was consumed — the ladder was never invoked.
    expect(rows[0].attempts).toBe(1);
  });

  it("still retries an ordinary error rather than treating it as non-retryable", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "vuln_feed_refresh", null);
    const ordinary = { vuln_feed_refresh: async () => { throw new Error("HTTP 500"); } };
    const res = await processJobs(repo, ordinary);
    expect(res).toMatchObject({ claimed: 1, done: 0, failed: 0, retried: 1 });
    expect(rows[0].status).toBe("pending");
  });

  it("fails a job with no registered handler permanently", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    const res = await processJobs(repo, {});
    expect(res.failed).toBe(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toMatch(/no handler/i);
  });

  it("parks a job when the handler reports it is awaiting a callback", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "geogrid_run", "site-1");
    const res = await processJobs(repo, {
      geogrid_run: async () => ({ awaitingCallback: true as const }),
    });
    expect(res).toMatchObject({ awaiting: 1, done: 0, failed: 0 });
    expect(rows[0].status).toBe("awaiting_callback");
  });
});

describe("processJobs bookkeeping and time budget", () => {
  it("does not re-run a job whose handler succeeded when marking it done fails", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "plugin_install", "site-1");
    await enqueueJob(repo, "plugin_install", "site-2");
    const runs: string[] = [];
    const flaky: JobsRepo = {
      ...repo,
      async markDone(id, guard) {
        if (id === rows[0].id) throw new Error("jobs.markDone failed: connection reset");
        return repo.markDone(id, guard);
      },
    };
    const res = await processJobs(flaky, {
      plugin_install: async ({ job }) => { runs.push(job.site_id!); },
    });
    // Both handlers ran exactly once; the first job was NOT pushed back onto
    // the retry ladder (which would reinstall on a live site), and the
    // bookkeeping failure did not abort the loop before the second job.
    expect(runs).toEqual(["site-1", "site-2"]);
    expect(res).toMatchObject({ done: 2, retried: 0, failed: 0 });
    expect(rows[0].status).toBe("running");
    expect(rows[1].status).toBe("done");
  });

  it("keeps going when a failure write itself throws", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    await enqueueJob(repo, "snapshot_refresh", "site-2");
    const broken: JobsRepo = {
      ...repo,
      async retry() { throw new Error("jobs.retry failed: timeout"); },
    };
    const res = await processJobs(broken, {
      snapshot_refresh: async ({ job }) => { if (job.site_id === "site-1") throw new Error("nope"); },
    });
    expect(res.claimed).toBe(2);
    expect(rows[1].status).toBe("done");
  });

  it("stops claiming new jobs once the time budget is spent", async () => {
    const { repo, rows } = memoryJobsRepo();
    for (const s of ["a", "b", "c"]) await enqueueJob(repo, "snapshot_refresh", s);
    let t = 0;
    const res = await processJobs(repo, {
      snapshot_refresh: async () => { t += 200_000; },
    }, { max: 3, budgetMs: 120_000, now: () => t });
    // The first job overran the budget, so the other two stay pending
    // instead of being claimed (burning an attempt) and stranded when the
    // platform kills the function.
    expect(res.claimed).toBe(1);
    expect(rows.map((r) => r.status)).toEqual(["done", "pending", "pending"]);
    expect(rows[1].attempts).toBe(0);
  });

  it("guards each transition on the claimed status and attempt", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "geogrid_run", "site-1");
    // A stale reclaim (attempt 2) started while attempt 1 was still running;
    // attempt 1 finishing late must not overwrite attempt 2's row.
    const res = await processJobs(repo, {
      geogrid_run: async () => { rows[0].attempts = 2; },
    });
    expect(res.done).toBe(1);
    expect(rows[0].status).toBe("running");
  });
});

describe("processJobs deferral", () => {
  it("defers a job without spending an attempt and keeps its payload changes", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "update_all_plugins", "site-1", { actor: "u1" });
    const res = await processJobs(repo, {
      update_all_plugins: async () => {
        throw new DeferJob(120_000, "waiting for the pre-update backup", { backup_requested_at: 123 });
      },
    });
    expect(res).toMatchObject({ claimed: 1, deferred: 1, retried: 0, failed: 0 });
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].payload).toEqual({ actor: "u1", backup_requested_at: 123 });
    expect(new Date(rows[0].scheduled_for).getTime()).toBeGreaterThan(Date.now() + 100_000);
  });
});

describe("enqueueJob dedupe", () => {
  it("treats a running job of the same type and site as a duplicate", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "update_all_plugins", "site-1");
    rows[0].status = "running";
    expect(await enqueueJob(repo, "update_all_plugins", "site-1", {}, { dedupe: true })).toBeNull();
  });

  it("does not let a cancelled pending job block a new one", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "update_all_plugins", "site-1");
    rows[0].cancelled_at = "2026-09-29T00:00:00Z";
    expect(await enqueueJob(repo, "update_all_plugins", "site-1", {}, { dedupe: true })).not.toBeNull();
  });
});

describe("recoverStaleAwaiting", () => {
  it("does not resurrect a job whose callback landed after the stale list was read", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "geogrid_run", "site-1");
    rows[0].status = "awaiting_callback";
    rows[0].attempts = 1;
    const racing: JobsRepo = {
      ...repo,
      async listStaleAwaiting(ms) {
        const stale = (await repo.listStaleAwaiting(ms)).map((r) => ({ ...r }));
        rows[0].status = "done"; // the n8n callback lands now
        return stale;
      },
    };
    await recoverStaleAwaiting(racing, 0);
    expect(rows[0].status).toBe("done");
  });

  it("retries a stale parked job instead of failing it outright", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "geogrid_run", "site-1");
    await processJobs(repo, { geogrid_run: async () => ({ awaitingCallback: true as const }) });
    expect(rows[0].status).toBe("awaiting_callback");

    const res = await recoverStaleAwaiting(repo, 0);
    expect(res).toEqual({ retried: 1, failed: 0 });
    expect(rows[0].status).toBe("pending");
    expect(rows[0].last_error).toMatch(/callback never arrived/i);
    // rescheduled into the future, not immediately reclaimable
    expect(new Date(rows[0].scheduled_for).getTime()).toBeGreaterThan(Date.now());
  });

  it("fails a parked job once its attempts are exhausted", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "geogrid_run", "site-1");
    rows[0].status = "awaiting_callback";
    rows[0].attempts = 3;
    const res = await recoverStaleAwaiting(repo, 0);
    expect(res).toEqual({ retried: 0, failed: 1 });
    expect(rows[0].status).toBe("failed");
  });
});

describe("isOpenJobStatus / allSettled", () => {
  it("treats pending, running and awaiting_callback as open", () => {
    expect(isOpenJobStatus("pending")).toBe(true);
    expect(isOpenJobStatus("running")).toBe(true);
    expect(isOpenJobStatus("awaiting_callback")).toBe(true);
  });

  it("treats done and failed as settled, not open", () => {
    expect(isOpenJobStatus("done")).toBe(false);
    expect(isOpenJobStatus("failed")).toBe(false);
  });

  it("is not settled while any job in the list is still open", () => {
    expect(allSettled([{ status: "done" }, { status: "awaiting_callback" }])).toBe(false);
  });

  it("is settled once every job has reached a terminal status", () => {
    expect(allSettled([{ status: "done" }, { status: "failed" }])).toBe(true);
  });

  it("is vacuously settled for an empty list — nothing left to poll for", () => {
    expect(allSettled([])).toBe(true);
  });
});
