import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseJobsRepo } from "@/services/jobs/repo";

// cancelJobs exists so the MCP cancel_batch tool can cancel exactly the
// visible pending jobs its preview named, instead of cancelBatch's
// batch-wide update -- which stops every pending job sharing a batch_id
// regardless of whether the caller could see it. Its filter shape is the
// whole point: `.in("id", ids)`, `status = 'pending'`, `cancelled_at IS
// NULL`, or it would either miss the scoping entirely or resurrect an
// already-cancelled row's timestamp.

function fakeDb(rows: { id: string }[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder = {
    update(...args: unknown[]) { calls.push({ method: "update", args }); return builder; },
    in(...args: unknown[]) { calls.push({ method: "in", args }); return builder; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return builder; },
    is(...args: unknown[]) { calls.push({ method: "is", args }); return builder; },
    select(...args: unknown[]) { calls.push({ method: "select", args }); return builder; },
    then(onFulfilled: (v: { data: { id: string }[]; error: null }) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
    },
  };
  const db = {
    from(table: string) { calls.push({ method: "from", args: [table] }); return builder; },
  } as unknown as SupabaseClient;
  return { db, calls };
}

function fakeErrorDb() {
  const builder = {
    update() { return builder; },
    in() { return builder; },
    eq() { return builder; },
    is() { return builder; },
    select() { return builder; },
    then(onFulfilled: (v: { data: null; error: { message: string } }) => unknown) {
      return Promise.resolve({ data: null, error: { message: "connection refused" } }).then(onFulfilled);
    },
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe("supabaseJobsRepo.cancelJobs", () => {
  it("filters on .in('id', ids), status = pending, cancelled_at IS NULL", async () => {
    const { db, calls } = fakeDb([{ id: "job-1" }, { id: "job-2" }]);
    await supabaseJobsRepo(db).cancelJobs(["job-1", "job-2"]);

    expect(calls[0]).toEqual({ method: "from", args: ["jobs"] });
    expect(calls.some((c) => c.method === "update")).toBe(true);
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "in", args: ["id", ["job-1", "job-2"]] },
        { method: "eq", args: ["status", "pending"] },
        { method: "is", args: ["cancelled_at", null] },
      ]),
    );
  });

  it("stamps cancelled_at with a real timestamp", async () => {
    const { db, calls } = fakeDb([{ id: "job-1" }]);
    await supabaseJobsRepo(db).cancelJobs(["job-1"]);

    const update = calls.find((c) => c.method === "update");
    expect(update).toBeDefined();
    const payload = update!.args[0] as { cancelled_at: string };
    expect(typeof payload.cancelled_at).toBe("string");
    expect(Number.isNaN(new Date(payload.cancelled_at).getTime())).toBe(false);
  });

  it("returns the count of rows actually updated", async () => {
    const { db } = fakeDb([{ id: "job-1" }, { id: "job-2" }]);
    const result = await supabaseJobsRepo(db).cancelJobs(["job-1", "job-2", "job-3"]);
    expect(result).toBe(2);
  });

  it("short-circuits on an empty array without issuing a query", async () => {
    const { db, calls } = fakeDb([]);
    const result = await supabaseJobsRepo(db).cancelJobs([]);
    expect(result).toBe(0);
    // Never touches `db` at all -- `.in("id", [])` is not a filter any other
    // caller in this codebase sends to PostgREST.
    expect(calls).toEqual([]);
  });

  it("throws when the update fails", async () => {
    const db = fakeErrorDb();
    await expect(supabaseJobsRepo(db).cancelJobs(["job-1"])).rejects.toThrow(
      /jobs\.cancelJobs failed: connection refused/,
    );
  });
});
