import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { register, siteSummary } from "@/mcp/tools/sites";
import type { ToolCtx } from "@/mcp/context";
import { applyReadOnly, type TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";

const SITE_A = {
  id: "1b6e3d4f-5c7e-4a92-8d3b-6f4c2a9e7b51", name: "Alpha",
  url: "https://alpha.test", environment: "production", status: "connected",
  client_label: "Alpha Co",
};
const SITE_B = {
  id: "2c7f4e5a-6d8f-4b03-9e4c-7a5d3b1f8c62", name: "Beta",
  url: "https://beta.test", environment: "staging", status: "connected",
  client_label: null,
};

function viewerWith(perms: AppPermission[], grants: [string, "read" | "manage"][]): Viewer {
  return {
    id: "u1", email: "u@example.com", role: "admin",
    permissions: new Set(perms), grants: new Map(grants),
  };
}

/**
 * A ctx whose repo is a fake and whose audit calls are recorded, so a test can
 * assert that reads write no audit rows.
 */
export function ctxWith(base: Viewer, opts: { readOnly?: boolean } = {}) {
  const audited: { action: string; siteId: string | null; detail: Record<string, unknown> }[] = [];
  const all = [SITE_A, SITE_B];
  // A read-only token's viewer goes through the real applyReadOnly, as
  // authenticateToken does: write permissions stripped, grants demoted.
  const viewer = opts.readOnly ? applyReadOnly(base) : base;
  const auth: TokenAuth = {
    viewer, tokenId: "tok-1", readOnly: Boolean(opts.readOnly),
  };
  return {
    auth,
    audited,
    sites: {
      repo: {
        listSites: async () => all,
        getSite: async (id: string) => all.find((s) => s.id === id) ?? null,
        getSiteCredentials: async () => null,
      },
    },
    async audit(action: string, siteId: string | null, detail: Record<string, unknown>) {
      audited.push({ action, siteId, detail });
    },
  } as unknown as ToolCtx & {
    audited: { action: string; siteId: string | null; detail: Record<string, unknown> }[];
  };
}

async function connect(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  register(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const payload = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0].text);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("siteSummary", () => {
  it("always includes the environment", () => {
    expect(siteSummary(SITE_A as never).environment).toBe("production");
    expect(siteSummary(SITE_B as never).environment).toBe("staging");
  });

  it("resolves a concrete environment even when SiteRow.environment is absent", () => {
    // SiteRow.environment is optional (predates 0017_site_environment.sql for
    // some rows), so this must never come back undefined -- siteSummary has
    // to fall back to siteEnvironment()'s inference from the URL/label.
    const noEnvProd = {
      id: "3d8a5f6b-7e9f-4c14-8f5d-8b6e4c2a9f73", name: "Gamma",
      url: "https://gamma.example.com", environment: undefined, status: "connected",
      client_label: "Gamma Co",
    };
    const noEnvStaging = {
      id: "4e9b6a7c-8fa0-4d25-9a6e-9c7f5d3b0a84", name: "Delta",
      url: "https://staging.example.com", environment: undefined, status: "connected",
      client_label: null,
    };
    expect(siteSummary(noEnvProd as never).environment).toBe("production");
    expect(siteSummary(noEnvStaging as never).environment).toBe("staging");
  });
});

describe("list_sites", () => {
  it("returns every site for a viewer with sites.view_all, each with its environment", async () => {
    const { client, close } = await connect(ctxWith(viewerWith(["sites.view_all"], [])));
    const out = payload(await client.callTool({ name: "list_sites", arguments: {} }));
    expect(out.sites.map((s: { name: string }) => s.name)).toEqual(["Alpha", "Beta"]);
    expect(out.sites.every((s: { environment?: string }) => Boolean(s.environment))).toBe(true);
    await close();
  });

  it("returns only granted sites for a viewer without sites.view_all", async () => {
    const { client, close } = await connect(ctxWith(viewerWith([], [[SITE_B.id, "read"]])));
    const out = payload(await client.callTool({ name: "list_sites", arguments: {} }));
    expect(out.sites.map((s: { name: string }) => s.name)).toEqual(["Beta"]);
    await close();
  });

  it("filters by environment when asked", async () => {
    const { client, close } = await connect(ctxWith(viewerWith(["sites.view_all"], [])));
    const out = payload(await client.callTool({
      name: "list_sites", arguments: { environment: "staging" },
    }));
    expect(out.sites.map((s: { name: string }) => s.name)).toEqual(["Beta"]);
    await close();
  });

  it("logs nothing -- reads are not audited", async () => {
    const ctx = ctxWith(viewerWith(["sites.view_all"], []));
    const { client, close } = await connect(ctx);
    await client.callTool({ name: "list_sites", arguments: {} });
    expect(ctx.audited).toEqual([]);
    await close();
  });
});

describe("get_site", () => {
  it("returns the site when the viewer may see it", async () => {
    const { client, close } = await connect(ctxWith(viewerWith(["sites.view_all"], [])));
    const out = payload(await client.callTool({
      name: "get_site", arguments: { site_id: SITE_A.id },
    }));
    expect(out.site.name).toBe("Alpha");
    expect(out.site.environment).toBe("production");
    await close();
  });

  it("says NOT FOUND rather than forbidden for a site the viewer cannot see", async () => {
    const { client, close } = await connect(ctxWith(viewerWith([], [[SITE_B.id, "read"]])));
    const res = await client.callTool({ name: "get_site", arguments: { site_id: SITE_A.id } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    // The existence of a site is itself information: never reveal that the
    // site is real but off-limits.
    expect(textOf(res)).not.toMatch(/permission|forbidden|denied/i);
    await close();
  });

  it("logs nothing -- reads are not audited", async () => {
    const ctx = ctxWith(viewerWith(["sites.view_all"], []));
    const { client, close } = await connect(ctx);
    await client.callTool({ name: "get_site", arguments: { site_id: SITE_A.id } });
    expect(ctx.audited).toEqual([]);
    await close();
  });
});

describe("test_site_connection", () => {
  it("refuses a read-only token, naming the token rather than a permission", async () => {
    // The user holds sites.manage; the read-only token strips it. The
    // refusal must still point at the token, not the permission they hold.
    const ctx = ctxWith(viewerWith(["sites.view_all", "sites.manage"], []), { readOnly: true });
    const { client, close } = await connect(ctx);
    const res = await client.callTool({
      name: "test_site_connection", arguments: { site_id: SITE_A.id },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/read-only/i);
    expect(textOf(res)).toMatch(/token/i);
    expect(textOf(res)).not.toMatch(/permission/i);
    // Refused before it ever reaches the panel-mutating service call.
    expect(ctx.audited).toEqual([]);
    await close();
  });

  // Final review, Fix 3: the panel button this mirrors (runConnectionTest)
  // requires sites.manage, so a client-role token must not be able to probe
  // a site over MCP that it could not probe from the panel.
  it("refuses a viewer without sites.manage, naming the permission", async () => {
    const ctx = ctxWith(viewerWith(["sites.view_all"], []));
    const { client, close } = await connect(ctx);
    const res = await client.callTool({
      name: "test_site_connection", arguments: { site_id: SITE_A.id },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toContain("sites.manage");
    expect(textOf(res)).not.toMatch(/read-only/i);
    expect(ctx.audited).toEqual([]);
    await close();
  });

  it("lets a writable token with sites.manage reach the service", async () => {
    const ctx = ctxWith(viewerWith(["sites.view_all", "sites.manage"], []));
    const { client, close } = await connect(ctx);
    const res = await client.callTool({
      name: "test_site_connection", arguments: { site_id: SITE_A.id },
    });
    // Not blocked by the permission or write gate -- the fake repo's
    // getSiteCredentials returns null, so the service itself reports "Site
    // not found" rather than the tool refusing the call outright.
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(payload(res).error).toBe("Site not found");
    await close();
  });

  it("writes one mcp.test_site_connection audit row for a completed call", async () => {
    const ctx = ctxWith(viewerWith(["sites.view_all", "sites.manage"], []));
    const { client, close } = await connect(ctx);
    await client.callTool({
      name: "test_site_connection", arguments: { site_id: SITE_A.id },
    });
    // The service's own site.test_connection row is what a panel click
    // writes too; this mcp.-prefixed row (with the token id, via ctx.audit)
    // is what makes a token-driven probe distinguishable from a click.
    expect(ctx.audited).toHaveLength(1);
    expect(ctx.audited[0].action).toBe("mcp.test_site_connection");
    expect(ctx.audited[0].siteId).toBe(SITE_A.id);
    expect(ctx.audited[0].detail).toMatchObject({ args: { site_id: SITE_A.id }, ok: false });
    await close();
  });
});

describe("tool descriptions", () => {
  it("every registered tool warns about environments", async () => {
    const { client, close } = await connect(ctxWith(viewerWith(["sites.view_all"], [])));
    const { tools } = await client.listTools();
    expect(tools.length).toBe(3);
    for (const t of tools) expect(t.description, t.name).toMatch(/staging/i);
    await close();
  });
});
