import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "@/services/jobs/types";

// Security finding: cancelBatchAction / retryBatchAction were gated only on
// `queue.process` and then acted on every job sharing the batch_id, so a
// holder of that permission could cancel or re-run work on sites they have
// no grant for. They must act only on jobs whose site the viewer can
// *manage* -- the same scoping the MCP cancel_batch tool applies.
//
// Also: processQueueNowAction / drainQueueAction reported ok: true even when
// jobs failed.

const checkPermissionMock = vi.fn();
vi.mock("@/lib/authz/server", () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
  isDenied: (x: unknown) => typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// A chainable stand-in for the one direct `jobs` update the retry path
// issues. Records the filters so the test can see which ids were targeted.
const updateCalls: { values: unknown; inIds?: string[]; eqs: [string, unknown][] }[] = [];
function fakeDb() {
  return {
    from(table: string) {
      if (table !== "jobs") throw new Error(`unexpected table ${table}`);
      return {
        update(values: unknown) {
          const call: { values: unknown; inIds?: string[]; eqs: [string, unknown][] } = { values, eqs: [] };
          updateCalls.push(call);
          const chain = {
            in(col: string, ids: string[]) { if (col === "id") call.inIds = ids; return chain; },
            eq(col: string, v: unknown) { call.eqs.push([col, v]); return chain; },
            is() { return chain; },
            async select() { return { data: (call.inIds ?? []).map((id) => ({ id })), error: null }; },
          };
          return chain;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", email: "u@example.com" })),
  createServiceSupabase: vi.fn(() => fakeDb()),
}));

const batchJobsMock = vi.fn();
const cancelJobsMock = vi.fn(async (ids: string[]) => ids.length);
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({
    batchJobs: (...a: unknown[]) => batchJobsMock(...a),
    cancelJobs: (ids: string[]) => cancelJobsMock(ids),
    cancelBatch: () => { throw new Error("cancelBatch (unscoped) must not be called"); },
    retryFailedInBatch: () => { throw new Error("retryFailedInBatch (unscoped) must not be called"); },
  }),
}));

const processJobsMock = vi.fn();
vi.mock("@/services/jobs/service", () => ({
  processJobs: (...a: unknown[]) => processJobsMock(...a),
  recoverStaleAwaiting: vi.fn(async () => undefined),
}));
vi.mock("@/services/jobs/handlers", () => ({ buildJobHandlers: () => ({}) }));

import {
  cancelBatchAction, retryBatchAction, processQueueNowAction, drainQueueAction,
} from "@/app/(dashboard)/queue-actions";

function job(id: string, site_id: string, status: JobRow["status"]): JobRow {
  return {
    id, type: "plugin_install", site_id, batch_id: "b1", payload: {}, status, attempts: 1,
    scheduled_for: new Date(0).toISOString(), last_error: null, dismissed_at: null, finished_at: null,
  } as JobRow;
}

const viewer = {
  id: "u1", email: "u@example.com", role: "developer",
  permissions: new Set(["queue.process"]),
  grants: new Map([["site-manage", "manage"], ["site-read", "read"]]),
};

beforeEach(() => {
  checkPermissionMock.mockReset();
  checkPermissionMock.mockResolvedValue(viewer);
  batchJobsMock.mockReset();
  cancelJobsMock.mockClear();
  processJobsMock.mockReset();
  updateCalls.length = 0;
});

describe("cancelBatchAction scoping", () => {
  it("cancels only pending jobs on sites the viewer can manage", async () => {
    batchJobsMock.mockResolvedValue([
      job("j1", "site-manage", "pending"),
      job("j2", "site-read", "pending"),
      job("j3", "site-other", "pending"),
      job("j4", "site-manage", "done"),
    ]);
    const res = await cancelBatchAction("b1");
    expect(res).toEqual({ ok: true, cancelled: 1 });
    expect(cancelJobsMock).toHaveBeenCalledWith(["j1"]);
  });

  it("reports not found when the viewer can manage none of the batch's sites", async () => {
    batchJobsMock.mockResolvedValue([job("j2", "site-read", "pending"), job("j3", "site-other", "pending")]);
    const res = await cancelBatchAction("b1");
    expect(res.ok).toBe(false);
    expect(cancelJobsMock).not.toHaveBeenCalled();
  });
});

describe("retryBatchAction scoping", () => {
  it("retries only failed jobs on sites the viewer can manage", async () => {
    batchJobsMock.mockResolvedValue([
      job("j1", "site-manage", "failed"),
      job("j2", "site-read", "failed"),
      job("j3", "site-other", "failed"),
      job("j4", "site-manage", "done"),
    ]);
    const res = await retryBatchAction("b1");
    expect(res).toEqual({ ok: true, retried: 1 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].inIds).toEqual(["j1"]);
    expect(updateCalls[0].eqs).toContainEqual(["status", "failed"]);
  });

  it("issues no update when the viewer can manage none of the batch's sites", async () => {
    batchJobsMock.mockResolvedValue([job("j3", "site-other", "failed")]);
    const res = await retryBatchAction("b1");
    expect(res.ok).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });
});

describe("processQueueNowAction outcome", () => {
  it("is not ok when any job failed, and reports failed and retried counts", async () => {
    processJobsMock
      .mockResolvedValueOnce({ claimed: 3, done: 1, failed: 1, retried: 1, awaiting: 0 })
      .mockResolvedValueOnce({ claimed: 0, done: 0, failed: 0, retried: 0, awaiting: 0 });
    const res = await processQueueNowAction();
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ claimed: 3, done: 1, failed: 1, retried: 1 });
  });

  it("is ok when nothing failed", async () => {
    processJobsMock
      .mockResolvedValueOnce({ claimed: 2, done: 1, failed: 0, retried: 1, awaiting: 0 })
      .mockResolvedValueOnce({ claimed: 0, done: 0, failed: 0, retried: 0, awaiting: 0 });
    const res = await processQueueNowAction();
    expect(res).toMatchObject({ ok: true, failed: 0, retried: 1 });
  });

  it("drainQueueAction surfaces a failure", async () => {
    processJobsMock
      .mockResolvedValueOnce({ claimed: 1, done: 0, failed: 1, retried: 0, awaiting: 0 })
      .mockResolvedValueOnce({ claimed: 0, done: 0, failed: 0, retried: 0, awaiting: 0 });
    const res = await drainQueueAction("/x");
    expect(res.ok).toBe(false);
  });
});
