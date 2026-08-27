import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { addSite, testSiteConnection, mcpEndpointFor } from "@/services/sites/service";
import type { SitesRepo } from "@/services/sites/repo";
import type { SiteRow, SiteStatus } from "@/services/sites/types";
import { MockMcpClient } from "@/lib/mcp/mock";
import { McpAuthError, McpConnectionError } from "@/lib/mcp/errors";
import { decryptSecret } from "@/lib/crypto/secrets";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

function memoryRepo() {
  const sites: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];
  const repo: SitesRepo = {
    async insertSite(row) {
      const id = `site-${sites.length + 1}`;
      sites.push({ id, status: "connected", ...row });
      return { id };
    },
    async listSites() { return sites as unknown as SiteRow[]; },
    async getSite(id) { return (sites.find((s) => s.id === id) as unknown as SiteRow) ?? null; },
    async getSiteCredentials(id) {
      const s = sites.find((x) => x.id === id);
      return s
        ? {
            mcp_endpoint: s.mcp_endpoint as string,
            wp_username: s.wp_username as string,
            app_password_encrypted: s.app_password_encrypted as string,
          }
        : null;
    },
    async updateSiteStatus(id, status: SiteStatus) {
      const s = sites.find((x) => x.id === id);
      if (s) s.status = status;
    },
    async insertActivity(entry) { activity.push(entry); },
  };
  return { repo, sites, activity };
}

const INPUT = {
  name: "El Nido Guide", url: "https://elnidoguide.ph",
  wpUsername: "admin", appPassword: "aaaa bbbb cccc dddd",
};

describe("mcpEndpointFor", () => {
  it("derives the Novamira endpoint from a site URL", () => {
    expect(mcpEndpointFor("https://elnidoguide.ph")).toBe("https://elnidoguide.ph/wp-json/mcp/novamira");
    expect(mcpEndpointFor("https://elnidoguide.ph/")).toBe("https://elnidoguide.ph/wp-json/mcp/novamira");
  });
});

describe("addSite", () => {
  it("verifies MCP, stores encrypted password + capabilities, logs activity", async () => {
    const { repo, sites, activity } = memoryRepo();
    const mcp = async () =>
      new MockMcpClient({ abilities: [{ name: "novamira/run-wp-cli" }, { name: "rank-math/audit-site-seo" }] });

    const { id } = await addSite({ repo, mcp }, INPUT, "user-1");

    expect(id).toBe("site-1");
    const row = sites[0];
    expect(row.app_password_encrypted).not.toContain("aaaa");
    expect(await decryptSecret(row.app_password_encrypted as string)).toBe(INPUT.appPassword);
    expect((row.capabilities as { abilities: string[] }).abilities).toContain("novamira/run-wp-cli");
    expect(activity[0]).toMatchObject({ actor: "user-1", action: "site.connect" });
  });

  it("rejects with a friendly error when auth fails, and stores nothing", async () => {
    const { repo, sites } = memoryRepo();
    const mcp = async () => new MockMcpClient({ failWith: new McpAuthError("401") });
    await expect(addSite({ repo, mcp }, INPUT, "user-1")).rejects.toThrow(/application password/i);
    expect(sites).toHaveLength(0);
  });
});

describe("testSiteConnection", () => {
  it("marks reconnect_needed on auth failure", async () => {
    const { repo, sites } = memoryRepo();
    await addSite({ repo, mcp: async () => new MockMcpClient() }, INPUT, "user-1");
    const failing = async () => new MockMcpClient({ failWith: new McpAuthError("401") });
    const res = await testSiteConnection({ repo, mcp: failing }, "site-1", "user-1");
    expect(res).toMatchObject({ ok: false, status: "reconnect_needed" });
    expect(sites[0].status).toBe("reconnect_needed");
  });

  it("marks degraded on connection failure and connected on success", async () => {
    const { repo, sites } = memoryRepo();
    await addSite({ repo, mcp: async () => new MockMcpClient() }, INPUT, "user-1");
    const down = async () => new MockMcpClient({ failWith: new McpConnectionError("ENOTFOUND") });
    expect((await testSiteConnection({ repo, mcp: down }, "site-1", "u")).status).toBe("degraded");
    expect((await testSiteConnection({ repo, mcp: async () => new MockMcpClient() }, "site-1", "u")).status)
      .toBe("connected");
    expect(sites[0].status).toBe("connected");
  });
});
