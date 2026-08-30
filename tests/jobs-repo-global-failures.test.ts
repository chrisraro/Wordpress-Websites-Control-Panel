import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow } from "@/services/jobs/types";

// vuln_feed_refresh (and any future job type enqueued the same way) runs
// with site_id: null, so no per-site query can ever surface its failures --
// this is the read the dashboard's system-health panel uses instead.
// listGlobalFailures's filter shape is the whole point of the method: it
// must be site_id IS NULL (not a string comparison, which would match
// nothing -- NULL is never equal to NULL in Postgres), status = 'failed',
// and dismissed_at IS NULL, or dismissed failures would resurface, or a
// site-scoped failure would leak into an alert that claims to be global.
//
// dismissFailed(null, type) is the null-site counterpart of the existing
// per-site dismissFailed the GeoGrid page already relies on: it must stamp
// dismissed_at rather than deleting the row, so the failure (and its
// last_error) survives for diagnosis after the alert clears.

function fakeReadDb(rows: JobRow[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder = {
    select(...args: unknown[]) { calls.push({ method: "select", args }); return builder; },
    is(...args: unknown[]) { calls.push({ method: "is", args }); return builder; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return builder; },
    order(...args: unknown[]) { calls.push({ method: "order", args }); return builder; },
    then(onFulfilled: (v: { data: JobRow[]; error: null }) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
    },
  };
  const db = {
    from(table: string) { calls.push({ method: "from", args: [table] }); return builder; },
  } as unknown as SupabaseClient;
  return { db, calls };
}

function fakeServiceDb() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder = {
    update(...args: unknown[]) { calls.push({ method: "update", args }); return builder; },
    eq(...args: unknown[]) { calls.push({ method: "eq", args }); return builder; },
    is(...args: unknown[]) { calls.push({ method: "is", args }); return builder; },
    delete(...args: unknown[]) { calls.push({ method: "delete", args }); return builder; },
    then(onFulfilled: (v: { error: null }) => unknown) {
      return Promise.resolve({ error: null }).then(onFulfilled);
    },
  };
  const db = { from: () => builder } as unknown as SupabaseClient;
  return { db, calls };
}

let serviceDbCalls: Array<{ method: string; args: unknown[] }> = [];
vi.mock("@/lib/supabase/server", () => ({
  createServiceSupabase: () => {
    const { db, calls } = fakeServiceDb();
    serviceDbCalls = calls;
    return db;
  },
}));

// Imported after the mock above so dismissFailed's internal
// createServiceSupabase() call picks up the fake.
import { supabaseJobsRepo } from "@/services/jobs/repo";

beforeEach(() => {
  serviceDbCalls = [];
});

const ROW: JobRow = {
  id: "job-1", type: "vuln_feed_refresh", site_id: null, batch_id: null,
  payload: {}, status: "failed", attempts: 3,
  scheduled_for: "2026-08-29T00:00:00Z", last_error: "HTTP 429: Retry-After 60s",
  dismissed_at: null, finished_at: "2026-08-29T00:05:00Z",
};

describe("supabaseJobsRepo.listGlobalFailures", () => {
  it("filters on jobs with site_id IS NULL, status = 'failed', dismissed_at IS NULL", async () => {
    const { db, calls } = fakeReadDb([ROW]);
    await supabaseJobsRepo(db).listGlobalFailures();

    expect(calls[0]).toEqual({ method: "from", args: ["jobs"] });
    expect(calls.filter((c) => c.method === "is")).toEqual([
      { method: "is", args: ["site_id", null] },
      { method: "is", args: ["dismissed_at", null] },
    ]);
    expect(calls.filter((c) => c.method === "eq")).toEqual([
      { method: "eq", args: ["status", "failed"] },
    ]);
  });

  it("returns the rows the query resolves with, unmodified", async () => {
    const { db } = fakeReadDb([ROW]);
    const result = await supabaseJobsRepo(db).listGlobalFailures();
    expect(result).toEqual([ROW]);
  });
});

describe("supabaseJobsRepo.dismissFailed(null, type)", () => {
  it("stamps dismissed_at rather than deleting the row", async () => {
    await supabaseJobsRepo({} as SupabaseClient).dismissFailed(null, "vuln_feed_refresh");

    expect(serviceDbCalls.some((c) => c.method === "delete")).toBe(false);
    const update = serviceDbCalls.find((c) => c.method === "update");
    expect(update).toBeDefined();
    const payload = update!.args[0] as { dismissed_at: string };
    expect(typeof payload.dismissed_at).toBe("string");
    expect(Number.isNaN(new Date(payload.dismissed_at).getTime())).toBe(false);
  });

  it("filters on site_id IS NULL (not a string comparison), plus the type and failed status", async () => {
    await supabaseJobsRepo({} as SupabaseClient).dismissFailed(null, "vuln_feed_refresh");

    expect(serviceDbCalls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["type", "vuln_feed_refresh"] },
        { method: "eq", args: ["status", "failed"] },
        { method: "is", args: ["dismissed_at", null] },
        { method: "is", args: ["site_id", null] },
      ]),
    );
    // Never a string .eq("site_id", ...) call -- that would silently match
    // nothing against a null column in Postgres.
    expect(
      serviceDbCalls.some((c) => c.method === "eq" && c.args[0] === "site_id"),
    ).toBe(false);
  });

  it("still scopes by a real site id with .eq when one is given (existing per-site behaviour)", async () => {
    await supabaseJobsRepo({} as SupabaseClient).dismissFailed("site-1", "geogrid_run");

    expect(serviceDbCalls).toEqual(
      expect.arrayContaining([{ method: "eq", args: ["site_id", "site-1"] }]),
    );
    expect(
      serviceDbCalls.some((c) => c.method === "is" && c.args[0] === "site_id"),
    ).toBe(false);
  });
});
