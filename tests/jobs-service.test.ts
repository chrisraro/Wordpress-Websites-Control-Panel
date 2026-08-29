import { describe, it, expect } from "vitest";
import {
  allSettled, computeRetryDelayMs, enqueueJob, isOpenJobStatus, processJobs,
  recoverStaleAwaiting, NonRetryableError,
} from "@/services/jobs/service";
import type { JobsRepo } from "@/services/jobs/repo";
import type { JobRow, JobType } from "@/services/jobs/types";

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
        dismissed_at: null,
      });
      return { id };
    },
    async pendingExists(type: JobType, siteId: string | null) {
      return rows.some((r) => r.type === type && r.site_id === siteId && r.status === "pending");
    },
    async claim(n) {
      const due = rows.filter((r) => r.status === "pending").slice(0, n);
      due.forEach((r) => { r.status = "running"; r.attempts += 1; });
      return due.map((r) => ({ ...r }));
    },
    async markDone(id) { rows.find((r) => r.id === id)!.status = "done"; },
    async retry(id, error, retryAtIso) {
      const r = rows.find((x) => x.id === id)!;
      r.status = "pending"; r.last_error = error; r.scheduled_for = retryAtIso;
      // Mirrors JobsRepo.retry (src/services/jobs/repo.ts): a job going back
      // on the ladder must not stay dismissed, so it can reappear in the
      // failed-runs alert if it fails again.
      r.dismissed_at = null;
    },
    async markFailed(id, error) {
      const r = rows.find((x) => x.id === id)!;
      r.status = "failed"; r.last_error = error;
    },
    async batchJobs(batchId) {
      return rows.filter((r) => r.batch_id === batchId);
    },
    async markAwaiting(id) { rows.find((r) => r.id === id)!.status = "awaiting_callback"; },
    async getJob(id) { return rows.find((r) => r.id === id) ?? null; },
    async listStaleAwaiting() { return rows.filter((r) => r.status === "awaiting_callback"); },
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

    res = await processJobs(repo, boom);
    expect(res.retried).toBe(1);

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

describe("recoverStaleAwaiting", () => {
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
