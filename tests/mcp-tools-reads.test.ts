import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolCtx } from "@/mcp/context";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";

const SITE_ID = "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51";
const SITE = {
  id: SITE_ID, name: "Alpha", url: "https://alpha.test",
  environment: "production", status: "connected", client_label: null,
};

const BATCH_ID = "3d8a5f6b-7e9a-4c14-8f5d-8b6e4c2a9d73";

const SITE_TOOLS = ["get_inventory", "get_security", "get_seo", "get_geogrid"] as const;
const ALL_READ_TOOLS = [
  ...SITE_TOOLS, "list_reports", "get_report_link", "list_jobs", "get_batch",
] as const;

/**
 * Builds a ctx with fakes for every repo the six read groups touch,
 * recording audit calls so the "reads are not logged" assertion is real.
 */
function ctxFor(opts: {
  permissions?: AppPermission[]; grants?: [string, "read" | "manage"][];
} = {}) {
  const audited: { action: string }[] = [];
  const viewer: Viewer = {
    id: "u1", email: null, role: "admin",
    permissions: new Set(opts.permissions ?? []),
    grants: new Map(opts.grants ?? []),
  };
  const auth: TokenAuth = { viewer, tokenId: "tok-1", readOnly: false };
  return {
    auth,
    audited,
    sites: {
      repo: {
        listSites: async () => [SITE],
        getSite: async (id: string) => (id === SITE_ID ? SITE : null),
      },
    },
    inventory: {
      latestSnapshot: async () => ({
        payload: { core: { version: "6.8" }, plugins: [], themes: [] },
        taken_at: "2026-09-01T00:00:00Z",
      }),
    },
    security: {
      latestGrade: async () => ({ grade: "A" as const, score: 96 }),
      openVulns: async () => [],
      latestChecks: async () => ({ runAt: "2026-09-01T00:00:00Z", checks: [] }),
    },
    seo: { latestBySource: async () => ({}) },
    geogrid: {
      getConfigBySite: async () => null,
      latestPerKeyword: async () => ({}),
    },
    reports: {
      listForSite: async () => [],
      getById: async () => null,
    },
    jobsRead: {
      listJobs: async () => [],
      batchJobs: async () => [],
    },
    async audit(action: string) { audited.push({ action }); },
  } as unknown as ToolCtx & { audited: { action: string }[] };
}

async function connectAll(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  for (const name of ["inventory", "security", "seo", "geogrid", "reports", "jobs"]) {
    const mod = await import(`@/mcp/tools/${name}`);
    mod.register(server, ctx);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("read tools", () => {
  it("registers all eight", async () => {
    const { client, close } = await connectAll(ctxFor({ permissions: ["sites.view_all"] }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ALL_READ_TOOLS) expect(names, t).toContain(t);
    await close();
  });

  it("every description warns about environments", async () => {
    const { client, close } = await connectAll(ctxFor({ permissions: ["sites.view_all"] }));
    for (const t of (await client.listTools()).tools) {
      expect(t.description, t.name).toMatch(/staging/i);
    }
    await close();
  });

  it.each(SITE_TOOLS)("%s reports not found for a site the viewer cannot see", async (name) => {
    const { client, close } = await connectAll(ctxFor({ permissions: [], grants: [] }));
    const res = await client.callTool({ name, arguments: { site_id: SITE_ID } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    expect(textOf(res)).not.toMatch(/permission|forbidden|denied/i);
    await close();
  });

  it.each(SITE_TOOLS)("%s includes the site's environment in its result", async (name) => {
    const ctx = ctxFor({ permissions: ["sites.view_all"], grants: [[SITE_ID, "read"]] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name, arguments: { site_id: SITE_ID } });
    expect(JSON.parse(textOf(res)).site.environment).toBe("production");
    await close();
  });

  it("no read tool writes an audit row", async () => {
    const ctx = ctxFor({ permissions: ["sites.view_all"], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    for (const name of SITE_TOOLS) {
      await client.callTool({ name, arguments: { site_id: SITE_ID } });
    }
    await client.callTool({ name: "list_reports", arguments: {} });
    await client.callTool({ name: "get_report_link", arguments: { report_id: SITE_ID } });
    await client.callTool({ name: "list_jobs", arguments: {} });
    await client.callTool({ name: "get_batch", arguments: { batch_id: BATCH_ID } });
    expect(ctx.audited).toEqual([]);
    await close();
  });

  describe("get_inventory", () => {
    it("returns a null snapshot with a note when nothing has been collected", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      (ctx as unknown as { inventory: { latestSnapshot: () => Promise<null> } }).inventory
        .latestSnapshot = async () => null;
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_inventory", arguments: { site_id: SITE_ID } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const out = JSON.parse(textOf(res));
      expect(out.snapshot).toBeNull();
      expect(out.note).toMatch(/no inventory/i);
      await close();
    });
  });

  describe("get_security", () => {
    it("returns nulls with a note when no security data has been collected", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      const sec = (ctx as unknown as {
        security: { latestGrade: () => Promise<null>; latestChecks: () => Promise<null> };
      }).security;
      sec.latestGrade = async () => null;
      sec.latestChecks = async () => null;
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_security", arguments: { site_id: SITE_ID } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const out = JSON.parse(textOf(res));
      expect(out.grade).toBeNull();
      expect(out.checks).toBeNull();
      expect(out.note).toMatch(/no security/i);
      await close();
    });
  });

  describe("get_seo", () => {
    it("returns an empty sources map with a note when nothing has been collected", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_seo", arguments: { site_id: SITE_ID } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const out = JSON.parse(textOf(res));
      expect(out.sources).toEqual({});
      expect(out.note).toMatch(/no seo/i);
      await close();
    });
  });

  describe("get_geogrid", () => {
    it("reports no configuration as a normal state, not an error", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_geogrid", arguments: { site_id: SITE_ID } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const out = JSON.parse(textOf(res));
      expect(out.configured).toBe(false);
      expect(out.note).toMatch(/no geogrid configuration/i);
      await close();
    });

    it("fetches the latest snapshot per keyword when a config exists", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      const CONFIG = {
        id: "2c7f4e5a-6d8f-4b03-9e4c-7a5d3b1f8c62", site_id: SITE_ID,
        business_name: "Alpha Co", place_ref: null, keywords: ["plumber"],
        grid_size: 5, spacing_m: 500, center_lat: 1, center_lng: 2,
        provider: "stub" as const, created_at: "2026-09-01T00:00:00Z",
      };
      const geo = (ctx as unknown as {
        geogrid: {
          getConfigBySite: () => Promise<typeof CONFIG>;
          latestPerKeyword: (configId: string) => Promise<Record<string, unknown>>;
        };
      }).geogrid;
      let receivedConfigId = "";
      geo.getConfigBySite = async () => CONFIG;
      geo.latestPerKeyword = async (configId: string) => {
        receivedConfigId = configId;
        return { plumber: { id: "s1", config_id: configId, run_at: "now", keyword: "plumber", points: [] } };
      };
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_geogrid", arguments: { site_id: SITE_ID } });
      const out = JSON.parse(textOf(res));
      expect(out.configured).toBe(true);
      expect(receivedConfigId).toBe(CONFIG.id);
      expect(out.keywords.plumber.keyword).toBe("plumber");
      await close();
    });
  });

  describe("list_reports", () => {
    const REPORT = {
      id: "4e9b6c7d-8f0b-4d25-9a6e-9c7f5d3b0e84",
      site_id: SITE_ID,
      generated_at: "2026-09-01T00:00:00Z",
      sections: ["overview"],
      period_start: "2026-08-01",
      period_end: "2026-08-31",
      storage_path: "reports/alpha/2026-09-01.pdf",
      share_token: "shared-token-abc",
      auto: false,
    };

    it("never includes the share token, and includes the site's environment", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      (ctx as unknown as { reports: { listForSite: () => Promise<(typeof REPORT)[]> } }).reports
        .listForSite = async () => [REPORT];
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "list_reports", arguments: { site_id: SITE_ID } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const out = JSON.parse(textOf(res));
      expect(out.count).toBe(1);
      expect("share_token" in out.reports[0]).toBe(false);
      expect(out.reports[0].site.environment).toBe("production");
      await close();
    });

    it("reports not found for a site the viewer cannot see", async () => {
      const { client, close } = await connectAll(ctxFor({ permissions: [], grants: [] }));
      const res = await client.callTool({ name: "list_reports", arguments: { site_id: SITE_ID } });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/not found/i);
      expect(textOf(res)).not.toMatch(/permission|forbidden|denied/i);
      await close();
    });

    it("returns an empty list rather than erroring when nothing has been generated", async () => {
      const { client, close } = await connectAll(ctxFor({ permissions: ["sites.view_all"] }));
      const res = await client.callTool({ name: "list_reports", arguments: {} });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      expect(JSON.parse(textOf(res))).toEqual({ count: 0, reports: [] });
      await close();
    });
  });

  describe("get_report_link", () => {
    const REPORT_ID = "5f0c7d8e-9a1c-4e36-8b7f-0d8a6e4c1f95";

    it("returns not found for an unknown report id", async () => {
      const { client, close } = await connectAll(ctxFor({ permissions: ["sites.view_all"] }));
      const res = await client.callTool({ name: "get_report_link", arguments: { report_id: REPORT_ID } });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/not found/i);
      await close();
    });

    it("reports not found, not forbidden, for a report on a site the viewer cannot see", async () => {
      const ctx = ctxFor({ permissions: [], grants: [] });
      (ctx as unknown as { reports: { getById: () => Promise<unknown> } }).reports.getById = async () => ({
        id: REPORT_ID, site_id: SITE_ID, generated_at: "2026-09-01T00:00:00Z",
        sections: [], period_start: null, period_end: null,
        storage_path: "x.pdf", share_token: "tok", auto: false,
      });
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_report_link", arguments: { report_id: REPORT_ID } });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/not found/i);
      expect(textOf(res)).not.toMatch(/permission|forbidden|denied/i);
      await close();
    });

    it("returns the public /r/<token> path for an active report", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      (ctx as unknown as { reports: { getById: () => Promise<unknown> } }).reports.getById = async () => ({
        id: REPORT_ID, site_id: SITE_ID, generated_at: "2026-09-01T00:00:00Z",
        sections: [], period_start: null, period_end: null,
        storage_path: "x.pdf", share_token: "shared-token-abc", auto: false,
      });
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_report_link", arguments: { report_id: REPORT_ID } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const out = JSON.parse(textOf(res));
      expect(out.revoked).toBe(false);
      expect(out.path).toBe("/r/shared-token-abc");
      expect(out.site.environment).toBe("production");
      await close();
    });

    it("reports a revoked link as a successful result, not an error or a broken URL", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      (ctx as unknown as { reports: { getById: () => Promise<unknown> } }).reports.getById = async () => ({
        id: REPORT_ID, site_id: SITE_ID, generated_at: "2026-09-01T00:00:00Z",
        sections: [], period_start: null, period_end: null,
        storage_path: "x.pdf", share_token: null, auto: false,
      });
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_report_link", arguments: { report_id: REPORT_ID } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const out = JSON.parse(textOf(res));
      expect(out.revoked).toBe(true);
      expect(out.path).toBeNull();
      expect(out.note).toMatch(/revoked/i);
      await close();
    });
  });

  describe("list_jobs", () => {
    const JOB = {
      id: "job-1", type: "geogrid_run" as const, site_id: SITE_ID, batch_id: null,
      payload: {}, status: "done" as const, attempts: 1,
      scheduled_for: "2026-09-01T00:00:00Z", last_error: null,
      cancelled_at: null, dismissed_at: null, finished_at: "2026-09-01T00:05:00Z",
    };

    it("reports not found for a site the viewer cannot see", async () => {
      const { client, close } = await connectAll(ctxFor({ permissions: [], grants: [] }));
      const res = await client.callTool({ name: "list_jobs", arguments: { site_id: SITE_ID } });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/not found/i);
      expect(textOf(res)).not.toMatch(/permission|forbidden|denied/i);
      await close();
    });

    it("passes siteIds: null through to the repo for a viewer holding sites.view_all", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      let received: unknown;
      (ctx as unknown as { jobsRead: { listJobs: (f: unknown) => Promise<unknown[]> } }).jobsRead
        .listJobs = async (f) => { received = f; return [JOB]; };
      const { client, close } = await connectAll(ctx);
      await client.callTool({ name: "list_jobs", arguments: {} });
      expect(received).toMatchObject({ siteIds: null, limit: 20 });
      await close();
    });

    it("passes only the visible site ids through for a viewer scoped by grants", async () => {
      const ctx = ctxFor({ permissions: [], grants: [[SITE_ID, "read"]] });
      let received: unknown;
      (ctx as unknown as { jobsRead: { listJobs: (f: unknown) => Promise<unknown[]> } }).jobsRead
        .listJobs = async (f) => { received = f; return [JOB]; };
      const { client, close } = await connectAll(ctx);
      await client.callTool({ name: "list_jobs", arguments: {} });
      expect(received).toMatchObject({ siteIds: [SITE_ID] });
      await close();
    });

    it("passes status and limit through to the repo", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      let received: unknown;
      (ctx as unknown as { jobsRead: { listJobs: (f: unknown) => Promise<unknown[]> } }).jobsRead
        .listJobs = async (f) => { received = f; return []; };
      const { client, close } = await connectAll(ctx);
      await client.callTool({ name: "list_jobs", arguments: { status: "failed", limit: 5 } });
      expect(received).toMatchObject({ status: "failed", limit: 5 });
      await close();
    });

    it("includes each job's site environment", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      (ctx as unknown as { jobsRead: { listJobs: () => Promise<(typeof JOB)[]> } }).jobsRead
        .listJobs = async () => [JOB];
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "list_jobs", arguments: {} });
      const out = JSON.parse(textOf(res));
      expect(out.jobs[0].site.environment).toBe("production");
      await close();
    });
  });

  describe("get_batch", () => {
    const JOB_ON_SITE = {
      id: "job-1", type: "plugin_install" as const, site_id: SITE_ID, batch_id: BATCH_ID,
      payload: {}, status: "done" as const, attempts: 1,
      scheduled_for: "2026-09-01T00:00:00Z", last_error: null,
      cancelled_at: null, dismissed_at: null, finished_at: "2026-09-01T00:05:00Z",
    };

    it("returns the batch's jobs, each with its site's environment, and a done flag", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      (ctx as unknown as { jobsRead: { batchJobs: () => Promise<(typeof JOB_ON_SITE)[]> } }).jobsRead
        .batchJobs = async () => [JOB_ON_SITE];
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_batch", arguments: { batch_id: BATCH_ID } });
      expect((res as { isError?: boolean }).isError).toBeFalsy();
      const out = JSON.parse(textOf(res));
      expect(out.jobs).toHaveLength(1);
      expect(out.jobs[0].site.environment).toBe("production");
      expect(out.done).toBe(true);
      await close();
    });

    it("reports not found, not an empty list, when no job in the batch is visible", async () => {
      const ctx = ctxFor({ permissions: [], grants: [] });
      (ctx as unknown as { jobsRead: { batchJobs: () => Promise<(typeof JOB_ON_SITE)[]> } }).jobsRead
        .batchJobs = async () => [JOB_ON_SITE];
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_batch", arguments: { batch_id: BATCH_ID } });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/not found/i);
      expect(textOf(res)).not.toMatch(/permission|forbidden|denied/i);
      await close();
    });

    it("reports not found for a genuinely empty batch, even for a viewer who can see every site", async () => {
      const ctx = ctxFor({ permissions: ["sites.view_all"] });
      // jobsRead.batchJobs already defaults to an empty array in ctxFor.
      const { client, close } = await connectAll(ctx);
      const res = await client.callTool({ name: "get_batch", arguments: { batch_id: BATCH_ID } });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toMatch(/not found/i);
      await close();
    });
  });
});
