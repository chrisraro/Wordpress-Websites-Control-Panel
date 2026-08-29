import { describe, it, expect, vi, beforeEach } from "vitest";

// This is the endpoint a production run failed against: "Serper lookup
// failed for 1 of 81 grid points: timeout exceeded" used to discard 80 good
// points permanently on attempt 1 of 1. These tests cover the two fixes for
// that: (1) an n8n-reported `error` now retries on the normal job ladder
// instead of failing immediately, and (2) a per-point `measured` flag lets a
// partial result keep its good points instead of forcing all-or-nothing.
//
// verifyN8nRequest is mocked here (its own HMAC/secret behaviour is covered
// in tests/geogrid-callback.test.ts) so this file is free to exercise the
// route's own branching without also re-deriving a valid signature per call.

const getJobMock = vi.fn();
const retryMock = vi.fn();
const markFailedMock = vi.fn();
const markDoneMock = vi.fn();
const getConfigMock = vi.fn();
const completeGeoGridRunMock = vi.fn();

vi.mock("@/lib/n8n-auth", () => ({
  verifyN8nRequest: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  createServiceSupabase: () => ({}),
}));
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({
    getJob: (...args: unknown[]) => getJobMock(...args),
    retry: (...args: unknown[]) => retryMock(...args),
    markFailed: (...args: unknown[]) => markFailedMock(...args),
    markDone: (...args: unknown[]) => markDoneMock(...args),
  }),
}));
vi.mock("@/services/geogrid/repo", () => ({
  supabaseGeoGridRepo: () => ({
    getConfig: (...args: unknown[]) => getConfigMock(...args),
  }),
}));
vi.mock("@/services/geogrid/run", () => ({
  completeGeoGridRun: (...args: unknown[]) => completeGeoGridRunMock(...args),
}));

import { POST } from "@/app/api/webhooks/n8n/geogrid/route";

const CONFIG = {
  id: "cfg-1", site_id: "site-1", business_name: "Test Cafe", place_ref: null,
  keywords: ["coffee shop"], grid_size: 3, spacing_m: 1000,
  center_lat: 14.6, center_lng: 120.98, provider: "n8n", created_at: "2026-01-01T00:00:00Z",
};

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1", type: "geogrid_run", site_id: "site-1", batch_id: null,
    payload: { config_id: "cfg-1", keyword: "coffee shop" },
    status: "awaiting_callback", attempts: 1, scheduled_for: "2026-01-01T00:00:00Z",
    last_error: null,
    ...overrides,
  };
}

function req(body: unknown): Request {
  return new Request("https://panel.test/api/webhooks/n8n/geogrid", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

type Point = { idx: number; rank: number | null; measured?: boolean };

beforeEach(() => {
  getJobMock.mockReset();
  retryMock.mockReset();
  markFailedMock.mockReset();
  markDoneMock.mockReset();
  getConfigMock.mockReset();
  completeGeoGridRunMock.mockReset();
  getConfigMock.mockResolvedValue(CONFIG);
});

describe("POST /api/webhooks/n8n/geogrid — error retry ladder", () => {
  it("retries a first-reported failure instead of failing the run outright", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 1 }));
    const res = await POST(req({ run_id: "job-1", error: "timeout exceeded" }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "retry" });
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(markFailedMock).not.toHaveBeenCalled();
    const [id, msg, retryAtIso] = retryMock.mock.calls[0] as [string, string, string];
    expect(id).toBe("job-1");
    expect(msg).toMatch(/n8n reported: timeout exceeded/);
    expect(new Date(retryAtIso).getTime()).toBeGreaterThan(Date.now());
  });

  it("retries again on the second reported failure, on the wider ladder step", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 2 }));
    const res = await POST(req({ run_id: "job-1", error: "timeout exceeded" }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "retry" });
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(markFailedMock).not.toHaveBeenCalled();
  });

  it("fails the run only once the retry ladder is exhausted", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 3 }));
    const res = await POST(req({ run_id: "job-1", error: "timeout exceeded" }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "error" });
    expect(markFailedMock).toHaveBeenCalledTimes(1);
    expect(markFailedMock.mock.calls[0][0]).toBe("job-1");
    expect(markFailedMock.mock.calls[0][1]).toMatch(/n8n reported: timeout exceeded/);
    expect(retryMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/n8n/geogrid — measured contract", () => {
  it("marks a grid point missing entirely from ranks[] as unmeasured, not a confirmed non-rank", async () => {
    getJobMock.mockResolvedValue(baseJob());
    await POST(req({ run_id: "job-1", ranks: [{ idx: 0, rank: 3 }] })); // grid_size 3 -> 9 points total
    expect(markFailedMock).not.toHaveBeenCalled();
    expect(completeGeoGridRunMock).toHaveBeenCalledTimes(1);
    const points = completeGeoGridRunMock.mock.calls[0][3] as Point[];
    expect(points).toHaveLength(9);
    expect(points.find((p) => p.idx === 0)).toMatchObject({ rank: 3, measured: true });
    // Every other point was never reported at all -> unmeasured, rank null.
    for (const p of points.filter((p) => p.idx !== 0)) {
      expect(p).toMatchObject({ rank: null, measured: false });
    }
  });

  it("honours an explicit measured: false and discards any rank sent alongside it", async () => {
    getJobMock.mockResolvedValue(baseJob());
    await POST(req({ run_id: "job-1", ranks: [{ idx: 0, rank: 5, measured: false }] }));
    const points = completeGeoGridRunMock.mock.calls[0][3] as Point[];
    expect(points.find((p) => p.idx === 0)).toMatchObject({ rank: null, measured: false });
  });

  it("defaults measured to true when the field is absent, for the current n8n workflow", async () => {
    getJobMock.mockResolvedValue(baseJob());
    await POST(req({ run_id: "job-1", ranks: [{ idx: 0, rank: 2 }] }));
    const points = completeGeoGridRunMock.mock.calls[0][3] as Point[];
    expect(points.find((p) => p.idx === 0)).toMatchObject({ rank: 2, measured: true });
  });

  it("still marks the run done once every point has been accounted for", async () => {
    getJobMock.mockResolvedValue(baseJob());
    await POST(req({ run_id: "job-1", ranks: [{ idx: 0, rank: 1 }] }));
    expect(markDoneMock).toHaveBeenCalledWith("job-1");
  });
});
