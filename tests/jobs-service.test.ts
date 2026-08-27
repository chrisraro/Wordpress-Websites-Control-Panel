import { describe, it, expect } from "vitest";
import {
  computeRetryDelayMs, enqueueJob, processJobs,
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
    },
    async markFailed(id, error) {
      const r = rows.find((x) => x.id === id)!;
      r.status = "failed"; r.last_error = error;
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

  it("fails a job with no registered handler permanently", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    const res = await processJobs(repo, {});
    expect(res.failed).toBe(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toMatch(/no handler/i);
  });
});
