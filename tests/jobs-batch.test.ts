import { describe, it, expect } from "vitest";
import { enqueueBatch } from "@/services/jobs/service";
import type { JobsRepo } from "@/services/jobs/repo";
import type { JobRow, JobType } from "@/services/jobs/types";

function memoryRepo() {
  const rows: Array<JobRow & { batch_id: string | null }> = [];
  let seq = 0;
  const repo = {
    async insert(job: { type: JobType; site_id?: string | null; payload?: Record<string, unknown>; batch_id?: string | null }) {
      const id = `job-${++seq}`;
      rows.push({
        id, type: job.type, site_id: job.site_id ?? null, batch_id: job.batch_id ?? null,
        payload: job.payload ?? {}, status: "pending", attempts: 0,
        scheduled_for: new Date(0).toISOString(), last_error: null,
      });
      return { id };
    },
    async batchJobs(batchId: string) { return rows.filter((r) => r.batch_id === batchId); },
  } as unknown as JobsRepo;
  return { repo, rows };
}

describe("enqueueBatch", () => {
  it("inserts one job per site under a shared uuid batch id", async () => {
    const { repo, rows } = memoryRepo();
    const payload = { source: { kind: "wporg", slug: "akismet" }, activate: true };
    const res = await enqueueBatch(repo, "plugin_install", ["s1", "s2", "s3"], payload);
    expect(res.count).toBe(3);
    expect(res.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.batch_id))).toEqual(new Set([res.batchId]));
    expect(rows.map((r) => r.site_id)).toEqual(["s1", "s2", "s3"]);
    expect(rows[0].payload).toEqual(payload);
  });
  it("rejects an empty site list", async () => {
    const { repo } = memoryRepo();
    await expect(enqueueBatch(repo, "plugin_install", [], {})).rejects.toThrow(/at least one site/i);
  });
});
