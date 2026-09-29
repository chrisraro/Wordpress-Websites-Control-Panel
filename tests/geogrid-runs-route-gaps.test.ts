import { describe, it, expect, vi, beforeEach } from "vitest";

// Complements tests/geogrid-runs-route.test.ts (auth gate, done verdict, key
// whitelist) and tests/job-error-redaction.test.ts (non-staff redaction of a
// failed run): the query scoping and the error-body contract.

const state = vi.hoisted(() => ({
  viewer: null as unknown,
  result: { data: [] as unknown, error: null as unknown },
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("@/lib/authz/server", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceSupabase: () => {
    const q: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["select", "eq", "order"]) {
      q[m] = (...a) => { state.calls.push([m, ...a]); return q; };
    }
    q.limit = async (...a) => { state.calls.push(["limit", ...a]); return state.result; };
    return { from: (t: string) => { state.calls.push(["from", t]); return q; } };
  },
}));

import { GET } from "@/app/api/sites/[id]/geogrid-runs/route";
import type { AppPermission } from "@/lib/authz/types";

const SITE_ID = "11111111-1111-1111-1111-111111111111";
const ctx = { params: Promise.resolve({ id: SITE_ID }) };
const viewer = (perms: AppPermission[], grants: Array<[string, "read" | "manage"]> = []) => ({
  id: "u1", email: null, role: "developer", permissions: new Set(perms), grants: new Map(grants),
});

beforeEach(() => {
  state.viewer = viewer([], [[SITE_ID, "read"]]);
  state.result = { data: [], error: null };
  state.calls = [];
});

describe("GET /api/sites/[id]/geogrid-runs — gaps", () => {
  it("scopes the query to this site's geogrid_run jobs, newest first, capped at 20", async () => {
    await GET(new Request("https://panel.test"), ctx);
    expect(state.calls).toEqual(expect.arrayContaining([
      ["from", "jobs"],
      ["eq", "site_id", SITE_ID],
      ["eq", "type", "geogrid_run"],
      ["order", "scheduled_for", { ascending: false }],
      ["limit", 20],
    ]));
  });

  it("returns an empty keyword when the payload has none or a non-string one", async () => {
    state.result = {
      data: [
        { id: "a", status: "done", payload: null, last_error: null },
        { id: "b", status: "done", payload: { keyword: 42 }, last_error: null },
      ],
      error: null,
    };
    const body = await (await GET(new Request("https://panel.test"), ctx)).json();
    expect(body.jobs.map((j: { keyword: string }) => j.keyword)).toEqual(["", ""]);
  });

  it("treats a null data set as no runs", async () => {
    state.result = { data: null, error: null };
    const body = await (await GET(new Request("https://panel.test"), ctx)).json();
    expect(body).toEqual({ jobs: [], done: true });
  });

  it("does not leak the database error message in its 500 body", async () => {
    state.result = { data: null, error: { message: "relation jobs does not exist; host=db.internal" } };
    const res = await GET(new Request("https://panel.test"), ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "failed to load runs" });
  });

  it("serves a viewer holding a manage grant, not just read", async () => {
    state.viewer = viewer([], [[SITE_ID, "manage"]]);
    const res = await GET(new Request("https://panel.test"), ctx);
    expect(res.status).toBe(200);
  });

  it("404s a viewer whose only grant is on a different site", async () => {
    state.viewer = viewer([], [["99999999-9999-9999-9999-999999999999", "manage"]]);
    const res = await GET(new Request("https://panel.test"), ctx);
    expect(res.status).toBe(404);
  });
});
