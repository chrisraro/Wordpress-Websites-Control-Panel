import { describe, it, expect, vi, beforeEach } from "vitest";

// Backs the GeoGrid tab's live poller (run-poller.tsx). These tests cover
// the two things that route must get right: (1) it is gated on the same
// site-access check as the page itself and refuses identically whether the
// site doesn't exist or simply isn't the viewer's, and (2) its "still open
// vs settled" verdict, which is what stops the poller.

const getViewerMock = vi.fn();
const canAccessSiteMock = vi.fn();

vi.mock("@/lib/authz/server", () => ({
  getViewer: (...args: unknown[]) => getViewerMock(...args),
}));
vi.mock("@/lib/authz/decide", () => ({
  canAccessSite: (...args: unknown[]) => canAccessSiteMock(...args),
}));

let queryResult: { data: unknown; error: unknown } = { data: [], error: null };
vi.mock("@/lib/supabase/server", () => ({
  createServiceSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => queryResult,
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { GET } from "@/app/api/sites/[id]/geogrid-runs/route";

const SITE_ID = "11111111-1111-1111-1111-111111111111";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  getViewerMock.mockReset();
  canAccessSiteMock.mockReset();
  queryResult = { data: [], error: null };
});

describe("GET /api/sites/[id]/geogrid-runs — authorisation", () => {
  it("404s with no viewer, not an empty body — keeps the poller's JSON contract", async () => {
    getViewerMock.mockResolvedValue(null);
    const res = await GET(new Request("https://panel.test"), ctx(SITE_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("400s a malformed site id before ever checking access", async () => {
    getViewerMock.mockResolvedValue({ id: "u1" });
    const res = await GET(new Request("https://panel.test"), ctx("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(canAccessSiteMock).not.toHaveBeenCalled();
  });

  it("404s a viewer with no grant on the site — identical status to a missing site", async () => {
    getViewerMock.mockResolvedValue({ id: "u1" });
    canAccessSiteMock.mockReturnValue(false);
    const res = await GET(new Request("https://panel.test"), ctx(SITE_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("checks access at read level, matching the page's own requireSiteAccess default", async () => {
    getViewerMock.mockResolvedValue({ id: "u1" });
    canAccessSiteMock.mockReturnValue(true);
    await GET(new Request("https://panel.test"), ctx(SITE_ID));
    expect(canAccessSiteMock).toHaveBeenCalledWith({ id: "u1" }, SITE_ID, "read");
  });
});

describe("GET /api/sites/[id]/geogrid-runs — still open vs settled", () => {
  beforeEach(() => {
    getViewerMock.mockResolvedValue({ id: "u1" });
    canAccessSiteMock.mockReturnValue(true);
  });

  it("reports done:false while any run is still open", async () => {
    queryResult = {
      data: [
        { id: "job-1", status: "awaiting_callback", payload: { keyword: "coffee shop" }, last_error: null },
        { id: "job-2", status: "done", payload: { keyword: "cafe" }, last_error: null },
      ],
      error: null,
    };
    const res = await GET(new Request("https://panel.test"), ctx(SITE_ID));
    const body = await res.json();
    expect(body.done).toBe(false);
    expect(body.jobs).toHaveLength(2);
  });

  it("reports done:true once every run has settled, and includes the failure reason", async () => {
    queryResult = {
      data: [
        { id: "job-1", status: "failed", payload: { keyword: "coffee shop" }, last_error: "n8n reported: timeout" },
        { id: "job-2", status: "done", payload: { keyword: "cafe" }, last_error: null },
      ],
      error: null,
    };
    const res = await GET(new Request("https://panel.test"), ctx(SITE_ID));
    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.jobs[0]).toEqual({
      id: "job-1", status: "failed", keyword: "coffee shop", last_error: "n8n reported: timeout",
    });
  });

  it("reports done:true with no run jobs at all — nothing to watch", async () => {
    queryResult = { data: [], error: null };
    const res = await GET(new Request("https://panel.test"), ctx(SITE_ID));
    expect(await res.json()).toEqual({ jobs: [], done: true });
  });

  it("never leaks config ids, site details or credentials — only id/status/keyword/error", async () => {
    queryResult = {
      data: [
        {
          id: "job-1", status: "running",
          payload: { keyword: "coffee shop", config_id: "cfg-secret" },
          last_error: null,
        },
      ],
      error: null,
    };
    const res = await GET(new Request("https://panel.test"), ctx(SITE_ID));
    const body = await res.json();
    expect(Object.keys(body.jobs[0]).sort()).toEqual(["id", "keyword", "last_error", "status"]);
  });

  it("500s if the underlying jobs query fails, instead of silently reporting done", async () => {
    queryResult = { data: null, error: { message: "boom" } };
    const res = await GET(new Request("https://panel.test"), ctx(SITE_ID));
    expect(res.status).toBe(500);
  });
});
