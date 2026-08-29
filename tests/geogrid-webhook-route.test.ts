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

  it("walks the whole ladder across three callbacks: retry, retry, fail — never fails on attempt 1 or 2", async () => {
    // Regression guard: a test that only checks "fails at attempt 3" passes
    // identically against code that always calls markFailed and never
    // retries. Asserting all three attempts in one test closes that gap.
    getJobMock.mockResolvedValue(baseJob({ attempts: 1 }));
    let res = await POST(req({ run_id: "job-1", error: "timeout exceeded" }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "retry" });
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(markFailedMock).not.toHaveBeenCalled();

    getJobMock.mockResolvedValue(baseJob({ attempts: 2 }));
    res = await POST(req({ run_id: "job-1", error: "timeout exceeded" }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "retry" });
    expect(retryMock).toHaveBeenCalledTimes(2);
    expect(markFailedMock).not.toHaveBeenCalled();

    getJobMock.mockResolvedValue(baseJob({ attempts: 3 }));
    res = await POST(req({ run_id: "job-1", error: "timeout exceeded" }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "error" });
    expect(markFailedMock).toHaveBeenCalledTimes(1);
    expect(retryMock).toHaveBeenCalledTimes(2);
  });

  it("does not discard a partial result: ranks[] alongside error is treated as the partial success it is", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 1 }));
    const res = await POST(req({
      run_id: "job-1",
      error: "Serper lookup failed for 1 of 9 grid points",
      ranks: [{ idx: 0, rank: 3 }],
    }));
    expect(await res.json()).toMatchObject({ ok: true, points: 9 });
    expect(retryMock).not.toHaveBeenCalled();
    expect(markFailedMock).not.toHaveBeenCalled();
    expect(completeGeoGridRunMock).toHaveBeenCalledTimes(1);
    const points = completeGeoGridRunMock.mock.calls[0][3] as Point[];
    expect(points.find((p) => p.idx === 0)).toMatchObject({ rank: 3, measured: true });
  });

  it("still retries on the ladder when ranks[] is present but empty", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 1 }));
    const res = await POST(req({ run_id: "job-1", error: "timeout exceeded", ranks: [] }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "retry" });
    expect(completeGeoGridRunMock).not.toHaveBeenCalled();
  });

  it("retries a whole-run outage reported per-point instead of recording a zero-coverage snapshot", async () => {
    // The shape the n8n workflow's per-point error handling produces for a
    // total outage: `hasRanks` alone is true (81 entries), but every one of
    // them is unmeasured, so this must not be indistinguishable from a real
    // "confirmed doesn't rank anywhere" run.
    getJobMock.mockResolvedValue(baseJob({ attempts: 1 }));
    const ranks = Array.from({ length: 9 }, (_, idx) => ({ idx, rank: null, measured: false }));
    const res = await POST(req({ run_id: "job-1", error: "quota exceeded", ranks }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "retry" });
    expect(retryMock).toHaveBeenCalledTimes(1);
    const [, msg] = retryMock.mock.calls[0] as [string, string, string];
    expect(msg).toMatch(/quota exceeded/);
    expect(completeGeoGridRunMock).not.toHaveBeenCalled();
    expect(markDoneMock).not.toHaveBeenCalled();
  });

  it("retries the same all-unmeasured shape even with no top-level error field at all", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 1 }));
    const ranks = Array.from({ length: 9 }, (_, idx) => ({ idx, rank: null, measured: false }));
    const res = await POST(req({ run_id: "job-1", ranks }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "retry" });
    expect(completeGeoGridRunMock).not.toHaveBeenCalled();
    expect(markDoneMock).not.toHaveBeenCalled();
  });

  it("fails an all-unmeasured run once the retry ladder is exhausted, same as an explicit error", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 3 }));
    const ranks = Array.from({ length: 9 }, (_, idx) => ({ idx, rank: null, measured: false }));
    const res = await POST(req({ run_id: "job-1", error: "quota exceeded", ranks }));
    expect(await res.json()).toMatchObject({ ok: true, recorded: "error" });
    expect(markFailedMock).toHaveBeenCalledTimes(1);
    expect(completeGeoGridRunMock).not.toHaveBeenCalled();
  });

  it("does not treat a genuine partial success (some points measured) as a total failure", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 1 }));
    const res = await POST(req({ run_id: "job-1", ranks: [{ idx: 0, rank: 3, measured: true }] }));
    expect(await res.json()).toMatchObject({ ok: true, points: 9 });
    expect(retryMock).not.toHaveBeenCalled();
    expect(completeGeoGridRunMock).toHaveBeenCalledTimes(1);
    expect(markDoneMock).toHaveBeenCalledWith("job-1");
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
    // idx 1 carries a real measurement so this body isn't itself the
    // whole-grid-unmeasured case covered separately above — this test is
    // only about how idx 0's own entry is parsed.
    await POST(req({
      run_id: "job-1",
      ranks: [{ idx: 0, rank: 5, measured: false }, { idx: 1, rank: 2, measured: true }],
    }));
    const points = completeGeoGridRunMock.mock.calls[0][3] as Point[];
    expect(points.find((p) => p.idx === 0)).toMatchObject({ rank: null, measured: false });
  });

  it("treats a stringified \"false\" as unmeasured rather than failing open to true", async () => {
    // n8n Set/Code nodes routinely stringify booleans. Failing open here
    // (treating anything not literally `false` as measured) is exactly the
    // corruption this branch exists to prevent: a failed lookup would land
    // as {rank: null, measured: true} — a confirmed non-rank.
    getJobMock.mockResolvedValue(baseJob());
    await POST(req({
      run_id: "job-1",
      ranks: [{ idx: 0, rank: 5, measured: "false" }, { idx: 1, rank: 2, measured: true }],
    }));
    const points = completeGeoGridRunMock.mock.calls[0][3] as Point[];
    expect(points.find((p) => p.idx === 0)).toMatchObject({ rank: null, measured: false });
  });

  it("keeps only the first entry for a duplicate idx", async () => {
    getJobMock.mockResolvedValue(baseJob());
    await POST(req({
      run_id: "job-1",
      ranks: [{ idx: 0, rank: 3, measured: true }, { idx: 0, measured: false }],
    }));
    const points = completeGeoGridRunMock.mock.calls[0][3] as Point[];
    expect(points.find((p) => p.idx === 0)).toMatchObject({ rank: 3, measured: true });
  });

  it("skips a null entry in ranks[] instead of throwing", async () => {
    getJobMock.mockResolvedValue(baseJob());
    const res = await POST(req({ run_id: "job-1", ranks: [null, { idx: 0, rank: 4 }] }));
    expect(res.status).toBe(200);
    const points = completeGeoGridRunMock.mock.calls[0][3] as Point[];
    expect(points.find((p) => p.idx === 0)).toMatchObject({ rank: 4, measured: true });
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

describe("POST /api/webhooks/n8n/geogrid — attempt identity", () => {
  it("looks up the job by the id portion and marks it done with the bare job id", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 2 }));
    const res = await POST(req({ run_id: "job-1:2", ranks: [{ idx: 0, rank: 1 }] }));
    expect(await res.json()).toMatchObject({ ok: true });
    expect(getJobMock).toHaveBeenCalledWith("job-1");
    expect(markDoneMock).toHaveBeenCalledWith("job-1");
  });

  it("rejects a callback whose attempt does not match the job's current attempt", async () => {
    // Simulates a late callback from a superseded execution: the job was
    // retried (now on attempt 2) but this callback belongs to attempt 1's
    // dispatch, which a re-dispatched attempt 2 has since raced.
    getJobMock.mockResolvedValue(baseJob({ attempts: 2 }));
    const res = await POST(req({ run_id: "job-1:1", ranks: [{ idx: 0, rank: 1 }] }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "stale attempt" });
    expect(completeGeoGridRunMock).not.toHaveBeenCalled();
    expect(markDoneMock).not.toHaveBeenCalled();
  });

  it("rejects a stale-attempt error callback the same way, so it cannot retry a superseded attempt", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 2 }));
    const res = await POST(req({ run_id: "job-1:1", error: "timeout exceeded" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: "stale attempt" });
    expect(retryMock).not.toHaveBeenCalled();
    expect(markFailedMock).not.toHaveBeenCalled();
  });

  it("accepts a bare job id with no :attempt suffix as attempt-agnostic, for runs dispatched by older code", async () => {
    getJobMock.mockResolvedValue(baseJob({ attempts: 2 }));
    const res = await POST(req({ run_id: "job-1", ranks: [{ idx: 0, rank: 1 }] }));
    expect(await res.json()).toMatchObject({ ok: true });
    expect(completeGeoGridRunMock).toHaveBeenCalledTimes(1);
  });
});
