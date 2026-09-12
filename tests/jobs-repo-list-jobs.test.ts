import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow } from "@/services/jobs/types";
import { supabaseJobsRepo } from "@/services/jobs/repo";

// list_jobs (Task 8b) needs a general job listing scoped to whichever sites
// the caller may see -- nothing in this repo offered that (batchJobs is
// scoped to one batch, getJob to one id, listGlobalFailures/listStaleAwaiting
// are each hardcoded to their own status). These tests pin: the full-row
// select, that `siteIds: null` (a viewer holding sites.view_all) applies no
// site filter at all, that an array scopes with `.in("site_id", ids)`, that
// `status` is optional and only filtered when given, that results are
// ordered newest-first by scheduled_for, that the limit is passed to the
// query itself (not applied by slicing the resolved array afterward -- a
// filtered-then-sliced page would silently return fewer rows than asked
// for), and that a query error throws with the Supabase error's message.

function fakeReadDb(rows: JobRow[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder = {
    select(...args: unknown[]) { calls.push({ method: "select", args }); return builder; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return builder; },
    in(...args: unknown[]) { calls.push({ method: "in", args }); return builder; },
    order(...args: unknown[]) { calls.push({ method: "order", args }); return builder; },
    limit(...args: unknown[]) { calls.push({ method: "limit", args }); return builder; },
    then(onFulfilled: (v: { data: JobRow[]; error: null }) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
    },
  };
  const db = {
    from(table: string) { calls.push({ method: "from", args: [table] }); return builder; },
  } as unknown as SupabaseClient;
  return { db, calls };
}

function fakeErrorDb(message: string) {
  const builder = {
    select() { return builder; },
    eq() { return builder; },
    in() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    then(onFulfilled: (v: { data: null; error: { message: string } }) => unknown) {
      return Promise.resolve({ data: null, error: { message } }).then(onFulfilled);
    },
  };
  const db = { from: () => builder } as unknown as SupabaseClient;
  return db;
}

const ROW: JobRow = {
  id: "job-1", type: "geogrid_run", site_id: "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51",
  batch_id: null, payload: {}, status: "done", attempts: 1,
  scheduled_for: "2026-09-01T00:00:00Z", last_error: null,
  dismissed_at: null, finished_at: "2026-09-01T00:05:00Z",
};

describe("supabaseJobsRepo.listJobs", () => {
  it("queries jobs and selects every column", async () => {
    const { db, calls } = fakeReadDb([ROW]);
    await supabaseJobsRepo(db).listJobs({ siteIds: null, limit: 20 });

    expect(calls[0]).toEqual({ method: "from", args: ["jobs"] });
    expect(calls).toEqual(expect.arrayContaining([{ method: "select", args: ["*"] }]));
  });

  it("applies no site filter when siteIds is null", async () => {
    const { db, calls } = fakeReadDb([ROW]);
    await supabaseJobsRepo(db).listJobs({ siteIds: null, limit: 20 });

    expect(calls.some((c) => c.method === "in")).toBe(false);
  });

  it("scopes to the given site ids with .in when siteIds is an array", async () => {
    const { db, calls } = fakeReadDb([ROW]);
    await supabaseJobsRepo(db).listJobs({ siteIds: ["site-a", "site-b"], limit: 20 });

    expect(calls).toEqual(
      expect.arrayContaining([{ method: "in", args: ["site_id", ["site-a", "site-b"]] }]),
    );
  });

  it("filters on status only when one is given", async () => {
    const { db: dbWith, calls: callsWith } = fakeReadDb([ROW]);
    await supabaseJobsRepo(dbWith).listJobs({ siteIds: null, status: "failed", limit: 20 });
    expect(callsWith).toEqual(
      expect.arrayContaining([{ method: "eq", args: ["status", "failed"] }]),
    );

    const { db: dbWithout, calls: callsWithout } = fakeReadDb([ROW]);
    await supabaseJobsRepo(dbWithout).listJobs({ siteIds: null, limit: 20 });
    expect(callsWithout.some((c) => c.method === "eq" && c.args[0] === "status")).toBe(false);
  });

  it("orders newest-first by scheduled_for", async () => {
    const { db, calls } = fakeReadDb([ROW]);
    await supabaseJobsRepo(db).listJobs({ siteIds: null, limit: 20 });

    expect(calls).toEqual(
      expect.arrayContaining([{ method: "order", args: ["scheduled_for", { ascending: false }] }]),
    );
  });

  it("passes the limit to the query itself", async () => {
    const { db, calls } = fakeReadDb([ROW]);
    await supabaseJobsRepo(db).listJobs({ siteIds: null, limit: 7 });

    expect(calls).toEqual(expect.arrayContaining([{ method: "limit", args: [7] }]));
  });

  it("returns the rows the query resolves with, unmodified", async () => {
    const { db } = fakeReadDb([ROW]);
    const result = await supabaseJobsRepo(db).listJobs({ siteIds: null, limit: 20 });
    expect(result).toEqual([ROW]);
  });

  it("throws with the Supabase error's message when the query errors", async () => {
    const db = fakeErrorDb("listJobs boom");
    await expect(supabaseJobsRepo(db).listJobs({ siteIds: null, limit: 20 }))
      .rejects.toThrow("listJobs boom");
  });
});
