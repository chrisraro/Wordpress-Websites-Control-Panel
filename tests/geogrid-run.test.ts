import { describe, it, expect } from "vitest";
import { runGeoGrid, completeGeoGridRun, type GeoGridRunDeps } from "@/services/geogrid/run";
import { stubProvider } from "@/services/geogrid/providers/stub";
import type { GeoGridRepo } from "@/services/geogrid/repo";
import type { GeoGridConfig, GeoGridProvider, RankPoint } from "@/services/geogrid/types";

const CONFIG: GeoGridConfig = {
  id: "cfg-1", site_id: "site-1", business_name: "Test Cafe", place_ref: null,
  keywords: ["coffee shop"], grid_size: 3, spacing_m: 1000,
  center_lat: 14.6, center_lng: 120.98, provider: "stub", created_at: "2026-01-01T00:00:00Z",
};

function fakeRepo(config: GeoGridConfig | null = CONFIG) {
  const snapshots: Array<{ configId: string; keyword: string; points: RankPoint[] }> = [];
  const repo = {
    async getConfig() { return config; },
    async insertSnapshot(configId: string, keyword: string, points: RankPoint[]) {
      snapshots.push({ configId, keyword, points });
    },
  } as unknown as GeoGridRepo;
  return { repo, snapshots };
}

function deps(repo: GeoGridRepo, n8n?: GeoGridProvider): GeoGridRunDeps {
  const awaiting: GeoGridProvider = n8n ?? {
    name: "n8n",
    async run() { return { kind: "awaiting" }; },
  };
  return { geogrid: repo, providers: { stub: stubProvider, n8n: awaiting }, appUrl: "https://panel.test" };
}

describe("runGeoGrid", () => {
  it("writes a snapshot immediately for the stub provider", async () => {
    const f = fakeRepo();
    const res = await runGeoGrid(deps(f.repo), "job-1", 1, "cfg-1", "coffee shop");
    expect(res).toEqual({ awaiting: false });
    expect(f.snapshots).toHaveLength(1);
    expect(f.snapshots[0].points).toHaveLength(9);
    expect(f.snapshots[0].keyword).toBe("coffee shop");
  });

  it("parks the run and writes nothing for the n8n provider", async () => {
    const f = fakeRepo({ ...CONFIG, provider: "n8n" });
    let received: { runId: string; callbackUrl: string } | null = null;
    const spy: GeoGridProvider = {
      name: "n8n",
      async run(req) { received = { runId: req.runId, callbackUrl: req.callbackUrl }; return { kind: "awaiting" }; },
    };
    const res = await runGeoGrid(deps(f.repo, spy), "job-9", 1, "cfg-1", "coffee shop");
    expect(res).toEqual({ awaiting: true });
    expect(f.snapshots).toHaveLength(0);
    expect(received).toEqual({
      runId: "job-9:1",
      callbackUrl: "https://panel.test/api/webhooks/n8n/geogrid",
    });
  });

  it("encodes the attempt number into the dispatched run_id, so a retry gets a distinct id", async () => {
    const f = fakeRepo({ ...CONFIG, provider: "n8n" });
    let received: string | null = null;
    const spy: GeoGridProvider = {
      name: "n8n",
      async run(req) { received = req.runId; return { kind: "awaiting" }; },
    };
    await runGeoGrid(deps(f.repo, spy), "job-9", 3, "cfg-1", "coffee shop");
    expect(received).toBe("job-9:3");
  });

  it("throws when the config is gone", async () => {
    const f = fakeRepo(null);
    await expect(runGeoGrid(deps(f.repo), "job-1", 1, "missing", "x")).rejects.toThrow(/config/i);
  });
});

describe("completeGeoGridRun", () => {
  it("stores the returned ranks", async () => {
    const f = fakeRepo();
    const ranks: RankPoint[] = [{ idx: 0, lat: 1, lng: 2, rank: 3 }];
    await completeGeoGridRun(f.repo, "cfg-1", "coffee shop", ranks);
    expect(f.snapshots[0]).toMatchObject({ configId: "cfg-1", keyword: "coffee shop", points: ranks });
  });
});
