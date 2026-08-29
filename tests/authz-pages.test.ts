import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Viewer } from "@/lib/authz/decide";
import type { SitesRepo } from "@/services/sites/repo";
import type { SiteRow } from "@/services/sites/types";

// This task gates the read surface (12 dashboard pages, the scoped site
// listing, and the batch status route). Page components render through
// Next.js and have no test harness in this repo, so what is unit-testable
// here is the two pieces of logic those pages and the route depend on:
// `listSitesForViewer`'s scoping, and the batch route's per-site filtering.

const FAKE_SITES: SiteRow[] = [
  { id: "s1" } as SiteRow,
  { id: "s2" } as SiteRow,
  { id: "s3" } as SiteRow,
];

function viewerWith(opts: { viewAll?: boolean; grants?: Record<string, "read" | "manage"> }): Viewer {
  return {
    id: "u1",
    email: "u1@example.com",
    role: opts.viewAll ? "admin" : "client",
    permissions: new Set(opts.viewAll ? ["sites.view_all"] : []),
    grants: new Map(Object.entries(opts.grants ?? {})),
  };
}

function memoryRepo(sites: SiteRow[]): SitesRepo {
  return {
    async listSites() { return sites; },
  } as unknown as SitesRepo;
}

describe("listSitesForViewer", () => {
  it("a viewer with sites.view_all sees every site", async () => {
    const { listSitesForViewer } = await import("@/services/sites/service");
    const viewer = viewerWith({ viewAll: true });
    const result = await listSitesForViewer(
      { repo: memoryRepo(FAKE_SITES), mcp: async () => { throw new Error("must not connect"); } },
      viewer,
    );
    expect(result.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("a client sees only the sites they were granted", async () => {
    const { listSitesForViewer } = await import("@/services/sites/service");
    const viewer = viewerWith({ grants: { s2: "read" } });
    const result = await listSitesForViewer(
      { repo: memoryRepo(FAKE_SITES), mcp: async () => { throw new Error("must not connect"); } },
      viewer,
    );
    expect(result.map((s) => s.id)).toEqual(["s2"]);
  });

  it("a client with no grants sees no sites", async () => {
    const { listSitesForViewer } = await import("@/services/sites/service");
    const viewer = viewerWith({});
    const result = await listSitesForViewer(
      { repo: memoryRepo(FAKE_SITES), mcp: async () => { throw new Error("must not connect"); } },
      viewer,
    );
    expect(result).toEqual([]);
  });
});

// --- /api/batches/[id] --------------------------------------------------
//
// The route must: require a viewer (404, not 401, per the panel's
// established "never confirm a protected thing exists" rule — see
// src/lib/authz/server.ts), then filter the batch's jobs down to sites the
// viewer may see. If nothing survives that filter, 404 — an empty jobs list
// would still confirm the batch id exists to someone who should not know
// that.

const getViewerMock = vi.fn();
vi.mock("@/lib/authz/server", () => ({
  getViewer: (...args: unknown[]) => getViewerMock(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServiceSupabase: () => ({}),
}));

const batchJobsMock = vi.fn();
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({ batchJobs: (...args: unknown[]) => batchJobsMock(...args) }),
}));

const SITES = [
  { id: "s1", name: "Site One" },
  { id: "s2", name: "Site Two" },
];
vi.mock("@/services/sites/repo", () => ({
  supabaseSitesRepo: () => ({ listSites: async () => SITES }),
}));

const VALID_ID = "11111111-1111-1111-1111-111111111111";

function job(overrides: Partial<{ id: string; site_id: string | null; status: string }>) {
  return {
    id: "job-1", site_id: "s1", status: "done", attempts: 1, last_error: null,
    payload: {}, type: "plugin_install",
    ...overrides,
  };
}

beforeEach(() => {
  getViewerMock.mockReset();
  batchJobsMock.mockReset();
});

describe("GET /api/batches/[id]", () => {
  it("returns 404 for an unauthenticated caller", async () => {
    getViewerMock.mockResolvedValue(null);
    const { GET } = await import("@/app/api/batches/[id]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(404);
    expect(batchJobsMock).not.toHaveBeenCalled();
  });

  it("a viewer with sites.view_all sees every job in the batch", async () => {
    getViewerMock.mockResolvedValue({
      id: "u1", email: null, role: "admin", permissions: new Set(["sites.view_all"]), grants: new Map(),
    });
    batchJobsMock.mockResolvedValue([job({ id: "j1", site_id: "s1" }), job({ id: "j2", site_id: "s2" })]);
    const { GET } = await import("@/app/api/batches/[id]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: VALID_ID }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(["j1", "j2"]);
  });

  it("a client only sees the jobs for sites they were granted", async () => {
    getViewerMock.mockResolvedValue({
      id: "u1", email: null, role: "client", permissions: new Set(),
      grants: new Map([["s1", "read"]]),
    });
    batchJobsMock.mockResolvedValue([job({ id: "j1", site_id: "s1" }), job({ id: "j2", site_id: "s2" })]);
    const { GET } = await import("@/app/api/batches/[id]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: VALID_ID }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(["j1"]);
    // The name of the site the client cannot see must not leak either.
    expect(JSON.stringify(body)).not.toContain("Site Two");
  });

  it("returns 404 — not an empty list — when none of the batch's sites are visible", async () => {
    getViewerMock.mockResolvedValue({
      id: "u1", email: null, role: "client", permissions: new Set(), grants: new Map(),
    });
    batchJobsMock.mockResolvedValue([job({ id: "j1", site_id: "s1" }), job({ id: "j2", site_id: "s2" })]);
    const { GET } = await import("@/app/api/batches/[id]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.jobs).toBeUndefined();
  });
});
