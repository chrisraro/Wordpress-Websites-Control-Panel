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

const SITE_TOOLS = ["get_inventory", "get_security", "get_seo", "get_geogrid"] as const;

/**
 * Builds a ctx with fakes for every repo the four read groups touch,
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
    async audit(action: string) { audited.push({ action }); },
  } as unknown as ToolCtx & { audited: { action: string }[] };
}

async function connectAll(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  for (const name of ["inventory", "security", "seo", "geogrid"]) {
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
  it("registers all four", async () => {
    const { client, close } = await connectAll(ctxFor({ permissions: ["sites.view_all"] }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of SITE_TOOLS) expect(names, t).toContain(t);
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
});
