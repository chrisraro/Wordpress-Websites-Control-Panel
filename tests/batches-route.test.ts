import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  viewer: null as unknown,
  jobs: [] as unknown[],
  sites: [] as Array<{ id: string; name: string }>,
  jobsError: null as Error | null,
  sitesError: null as Error | null,
  requestedBatch: null as string | null,
}));

vi.mock("@/lib/supabase/server", () => ({ createServiceSupabase: () => ({}) }));
vi.mock("@/lib/authz/server", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({
    batchJobs: async (id: string) => {
      state.requestedBatch = id;
      if (state.jobsError) throw state.jobsError;
      return state.jobs;
    },
  }),
}));
vi.mock("@/services/sites/repo", () => ({
  supabaseSitesRepo: () => ({
    listSites: async () => {
      if (state.sitesError) throw state.sitesError;
      return state.sites;
    },
  }),
}));

import { GET } from "@/app/api/batches/[id]/route";
import { GENERIC_JOB_ERROR } from "@/lib/authz/job-detail";
import type { AppPermission } from "@/lib/authz/types";

const BATCH = "22222222-2222-2222-2222-222222222222";
const SITE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RAW = "PHP Fatal error in /var/www/secret/path.php";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const call = (id = BATCH) => GET(new Request("https://panel.test"), ctx(id));

function viewer(perms: AppPermission[], grants: Array<[string, "read" | "manage"]> = []) {
  return { id: "u1", email: null, role: "developer", permissions: new Set(perms), grants: new Map(grants) };
}
const staff = () => viewer(["sites.view_all"]);

function job(over: Record<string, unknown> = {}) {
  return {
    id: "j1", type: "plugin_install", site_id: SITE_A, batch_id: BATCH,
    payload: { label: "Yoast" }, status: "done", attempts: 1,
    scheduled_for: "2026-01-01T00:00:00Z", last_error: null, cancelled_at: null,
    ...over,
  };
}

beforeEach(() => {
  Object.assign(state, {
    viewer: staff(), jobs: [job()], jobsError: null, sitesError: null, requestedBatch: null,
    sites: [{ id: SITE_A, name: "Alpha" }, { id: SITE_B, name: "Beta" }],
  });
});

describe("GET /api/batches/[id] — authorization", () => {
  it("404s with a JSON body when there is no viewer, and never touches the repo", async () => {
    state.viewer = null;
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(state.requestedBatch).toBeNull();
  });

  it("400s a malformed batch id before querying", async () => {
    const res = await call("not-a-uuid");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid batch id" });
    expect(state.requestedBatch).toBeNull();
  });

  it("404s a viewer with no grant on any site in the batch, identically to a missing batch", async () => {
    state.viewer = viewer([], []);
    const denied = await call();
    state.jobs = [];
    state.viewer = staff();
    const missing = await call();
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await denied.json()).toEqual(await missing.json());
  });

  it("hides jobs on sites the viewer cannot see, including their site names", async () => {
    state.viewer = viewer([], [[SITE_A, "read"]]);
    state.jobs = [job({ id: "ja", site_id: SITE_A }), job({ id: "jb", site_id: SITE_B })];
    const text = JSON.stringify(await (await call()).json());
    expect(text).toContain("ja");
    expect(text).not.toContain("jb");
    expect(text).not.toContain("Beta");
  });

  it("404s site-less jobs for a non-staff viewer", async () => {
    state.viewer = viewer([], [[SITE_A, "read"]]);
    state.jobs = [job({ site_id: null })];
    expect((await call()).status).toBe(404);
  });
});

describe("GET /api/batches/[id] — response shape", () => {
  it("returns the rows the poller needs and done:true when all are terminal", async () => {
    state.jobs = [
      job({ id: "j1", payload: { label: "Yoast", kind: "activate", target: "yoast", activate: true } }),
      job({ id: "j2", site_id: SITE_B, status: "failed", last_error: RAW, attempts: 3, payload: {} }),
    ];
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0]).toMatchObject({
      id: "j1", site_id: SITE_A, site_name: "Alpha", label: "Yoast", status: "done",
      type: "plugin_install", kind: "activate", target: "yoast", activate: true, cancelled_at: null,
    });
    // No payload label: falls back to the site name.
    expect(body.jobs[1]).toMatchObject({ id: "j2", label: "Beta", status: "failed" });
  });

  it("reports done:false while any job is pending or running", async () => {
    state.jobs = [job({ id: "j1" }), job({ id: "j2", status: "running" })];
    expect((await (await call()).json()).done).toBe(false);
  });

  it("treats a cancelled pending job as settled, so the poller stops", async () => {
    state.jobs = [job({ status: "pending", cancelled_at: "2026-01-01T00:00:00Z" })];
    expect((await (await call()).json()).done).toBe(true);
  });

  it("falls back to the site id when the site name is unknown", async () => {
    state.sites = [];
    state.jobs = [job({ payload: {} })];
    const body = await (await call()).json();
    expect(body.jobs[0].site_name).toBe(SITE_A);
  });

  it("ignores payload fields of the wrong type", async () => {
    state.jobs = [job({ payload: { label: 5, kind: {}, target: [], activate: "yes" } })];
    const row = (await (await call()).json()).jobs[0];
    expect(row.label).toBe("Alpha");
    expect(row.kind).toBeUndefined();
    expect(row.target).toBeUndefined();
    expect(row.activate).toBeUndefined();
  });
});

describe("GET /api/batches/[id] — diagnostics redaction", () => {
  it("gives staff the raw error and attempts", async () => {
    state.jobs = [job({ status: "failed", last_error: RAW, attempts: 3 })];
    const row = (await (await call()).json()).jobs[0];
    expect(row.last_error).toBe(RAW);
    expect(row.attempts).toBe(3);
  });

  it("gives a non-staff viewer a generic error and no attempts count", async () => {
    state.viewer = viewer([], [[SITE_A, "read"]]);
    state.jobs = [job({ status: "failed", last_error: RAW, attempts: 3 })];
    const text = JSON.stringify(await (await call()).json());
    expect(text).toContain(GENERIC_JOB_ERROR);
    expect(text).not.toContain(RAW);
    expect(text).not.toContain("attempts");
  });
});

describe("GET /api/batches/[id] — error paths", () => {
  it("propagates a jobs repo failure instead of answering with a partial body", async () => {
    state.jobsError = new Error("jobs.batchJobs failed");
    await expect(call()).rejects.toThrow("batchJobs failed");
  });

  it("propagates a sites repo failure instead of answering with a partial body", async () => {
    state.sitesError = new Error("sites.listSites failed");
    await expect(call()).rejects.toThrow("listSites failed");
  });
});
