import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({
  sites: [] as Array<{ id: string; url: string; status: string }>,
  listError: null as Error | null,
  insertError: null as Error | null,
  inserted: [] as unknown[][],
  checked: [] as string[],
  results: {} as Record<string, { ok: boolean; http_status: number | null }>,
}));

vi.mock("@/lib/supabase/server", () => ({ createServiceSupabase: () => ({}) }));
vi.mock("@/services/sites/repo", () => ({
  supabaseSitesRepo: () => ({
    listSites: async () => {
      if (state.listError) throw state.listError;
      return state.sites;
    },
  }),
}));
vi.mock("@/services/security/repo", () => ({
  supabaseSecurityRepo: () => ({
    insertUptime: async (rows: unknown[]) => {
      if (state.insertError) throw state.insertError;
      state.inserted.push(rows);
    },
  }),
}));
vi.mock("@/services/security/uptime", () => ({
  checkSite: async (url: string) => {
    state.checked.push(url);
    const r = state.results[url] ?? { ok: true, http_status: 200 };
    return { ...r, response_ms: 5, ssl_days_remaining: 30 };
  },
}));

import { GET, POST } from "@/app/api/cron/uptime/route";

const SECRET = "test-cron-secret";
const authed = (method = "POST", headers: Record<string, string> = { "x-cron-secret": SECRET }) =>
  new Request("http://x/api/cron/uptime", { method, headers });

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  Object.assign(state, { sites: [], listError: null, insertError: null, inserted: [], checked: [], results: {} });
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

describe("/api/cron/uptime — authorization", () => {
  it("returns 401 with no credentials and does no work", async () => {
    const res = await POST(new Request("http://x/api/cron/uptime", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(state.checked).toEqual([]);
    expect(state.inserted).toEqual([]);
  });

  it("returns 401 for a wrong x-cron-secret", async () => {
    const res = await POST(authed("POST", { "x-cron-secret": "nope" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 for a wrong bearer token", async () => {
    const res = await GET(authed("GET", { authorization: "Bearer nope" }));
    expect(res.status).toBe(401);
  });

  it("fails closed with 401 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(authed("POST", { "x-cron-secret": "" }));
    expect(res.status).toBe(401);
    expect(state.checked).toEqual([]);
  });

  it("accepts a Bearer token as well as x-cron-secret, on both GET and POST", async () => {
    const bearer = { authorization: `Bearer ${SECRET}` };
    expect((await GET(authed("GET", bearer))).status).toBe(200);
    expect((await POST(authed("POST", bearer))).status).toBe(200);
  });
});

describe("/api/cron/uptime — run", () => {
  it("checks every non-disabled site, skips disabled ones, and records one row per site", async () => {
    state.sites = [
      { id: "s1", url: "https://a.test", status: "connected" },
      { id: "s2", url: "https://b.test", status: "disabled" },
      { id: "s3", url: "https://c.test", status: "error" },
    ];
    const res = await POST(authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sites: 2, down: 0 });
    expect([...state.checked].sort()).toEqual(["https://a.test", "https://c.test"]);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toEqual([
      expect.objectContaining({ site_id: "s1", ok: true, http_status: 200 }),
      expect.objectContaining({ site_id: "s3", ok: true, http_status: 200 }),
    ]);
  });

  it("counts down sites in the response", async () => {
    state.sites = [
      { id: "s1", url: "https://a.test", status: "connected" },
      { id: "s2", url: "https://b.test", status: "connected" },
    ];
    state.results["https://b.test"] = { ok: false, http_status: null };
    const body = await (await POST(authed())).json();
    expect(body).toEqual({ ok: true, sites: 2, down: 1 });
  });

  it("succeeds with zero sites and still writes an empty batch", async () => {
    const body = await (await POST(authed())).json();
    expect(body).toEqual({ ok: true, sites: 0, down: 0 });
    expect(state.inserted).toEqual([[]]);
  });
});

describe("/api/cron/uptime — error paths", () => {
  it("propagates a listSites failure to Next's 500 handler without writing anything", async () => {
    state.listError = new Error("db down");
    await expect(POST(authed())).rejects.toThrow("db down");
    expect(state.inserted).toEqual([]);
  });

  it("propagates an insertUptime failure rather than reporting ok:true", async () => {
    state.sites = [{ id: "s1", url: "https://a.test", status: "connected" }];
    state.insertError = new Error("insert failed");
    await expect(POST(authed())).rejects.toThrow("insert failed");
  });
});
