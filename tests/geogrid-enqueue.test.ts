import { describe, expect, it } from "vitest";
import { enqueueGeoGridRun } from "@/services/geogrid/enqueue";
import type { GeoGridConfig } from "@/services/geogrid/types";
import type { JobsRepo } from "@/services/jobs/repo";

const SITE_ID = "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51";

const CONFIG: GeoGridConfig = {
  id: "2c7f4e5a-6d8f-4b03-9e4c-7a5d3b1f8c62",
  site_id: SITE_ID,
  business_name: "Alpha Co",
  place_ref: null,
  keywords: ["plumber", "electrician", "roofer"],
  grid_size: 5,
  spacing_m: 500,
  center_lat: 1,
  center_lng: 2,
  provider: "stub",
  created_at: "2026-09-01T00:00:00Z",
};

function fakeJobsRepo() {
  const inserted: {
    type: string; site_id?: string | null; batch_id?: string | null;
    payload?: Record<string, unknown>;
  }[] = [];
  const repo = {
    async insert(job: {
      type: string; site_id?: string | null; batch_id?: string | null;
      payload?: Record<string, unknown>;
    }) {
      inserted.push(job);
      return { id: `job-${inserted.length}` };
    },
  } as unknown as JobsRepo;
  return { repo, inserted };
}

describe("enqueueGeoGridRun", () => {
  it("inserts one job per keyword", async () => {
    const { repo, inserted } = fakeJobsRepo();
    const { queued } = await enqueueGeoGridRun(repo, SITE_ID, CONFIG);
    expect(inserted).toHaveLength(3);
    expect(queued).toBe(3);
  });

  it("gives every job the same batch id", async () => {
    const { repo, inserted } = fakeJobsRepo();
    const { batchId } = await enqueueGeoGridRun(repo, SITE_ID, CONFIG);
    expect(batchId).toBeTruthy();
    for (const job of inserted) expect(job.batch_id).toBe(batchId);
  });

  it("gives every job type geogrid_run and the site id", async () => {
    const { repo, inserted } = fakeJobsRepo();
    await enqueueGeoGridRun(repo, SITE_ID, CONFIG);
    for (const job of inserted) {
      expect(job.type).toBe("geogrid_run");
      expect(job.site_id).toBe(SITE_ID);
    }
  });

  it("gives each job a payload of config_id and its own keyword, in order", async () => {
    const { repo, inserted } = fakeJobsRepo();
    await enqueueGeoGridRun(repo, SITE_ID, CONFIG);
    expect(inserted.map((j) => j.payload)).toEqual([
      { config_id: CONFIG.id, keyword: "plumber" },
      { config_id: CONFIG.id, keyword: "electrician" },
      { config_id: CONFIG.id, keyword: "roofer" },
    ]);
  });

  it("queues nothing and returns a fresh batch id for a config with no keywords", async () => {
    const { repo, inserted } = fakeJobsRepo();
    const { batchId, queued } = await enqueueGeoGridRun(repo, SITE_ID, { ...CONFIG, keywords: [] });
    expect(inserted).toHaveLength(0);
    expect(queued).toBe(0);
    expect(batchId).toBeTruthy();
  });
});
