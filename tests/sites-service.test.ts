import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { addSite, testSiteConnection, mcpEndpointFor } from "@/services/sites/service";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";
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
    async setSiteEnvironment() {},
    async setSiteOrigin() {},
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
    async getSiteConnection(id) {
      const s = sites.find((x) => x.id === id);
      return s
        ? {
            mcp_endpoint: s.mcp_endpoint as string, wp_username: s.wp_username as string,
            origin_ip: (s.origin_ip as string | null) ?? null,
            origin_sni: (s.origin_sni as string | null) ?? null,
          }
        : null;
    },
    async updateSiteStatus(id, status: SiteStatus) {
      const s = sites.find((x) => x.id === id);
      if (s) s.status = status;
    },
    async insertActivity(entry) { activity.push(entry); },
    async recordScanResult() {},
  };
  return { repo, sites, activity };
}

/** A minimal in-memory JobsRepo — only `insert` and `pendingExists` (what
 *  enqueueJob calls) do anything; the rest are unused by these tests. */
function memoryJobsRepo(opts: { failInsert?: boolean } = {}) {
  const jobs: Array<{ id: string; type: string; site_id: string | null; payload: Record<string, unknown> }> = [];
  const repo: JobsRepo = {
    async insert(job) {
      if (opts.failInsert) throw new Error("jobs.insert failed: connection refused");
      const id = `job-${jobs.length + 1}`;
      jobs.push({ id, type: job.type, site_id: job.site_id ?? null, payload: job.payload ?? {} });
      return { id };
    },
    async pendingExists(type, siteId) {
      return jobs.some((j) => j.type === type && j.site_id === siteId);
    },
    async claim() { return []; },
    async markDone() {},
    async retry() {},
    async markFailed() {},
    async batchJobs() { return []; },
    async markAwaiting() {},
    async getJob() { return null; },
    async listStaleAwaiting() { return []; },
    async listGlobalFailures() { return []; },
    async cancelBatch() { return 0; },
    async retryFailedInBatch() { return 0; },
    async dismissFailed() {},
  };
  return { repo, jobs };
}

const INPUT = {
  name: "El Nido Guide", url: "https://elnidoguide.ph",
  wpUsername: "admin", appPassword: "aaaa bbbb cccc dddd",
  environment: "production" as const,
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
    const { repo: jobs } = memoryJobsRepo();
    const mcp = async () =>
      new MockMcpClient({ abilities: [{ name: "novamira/run-wp-cli" }, { name: "rank-math/audit-site-seo" }] });

    const { id } = await addSite({ repo, mcp, jobs }, INPUT, "user-1");

    expect(id).toBe("site-1");
    const row = sites[0];
    expect(row.app_password_encrypted).not.toContain("aaaa");
    expect(await decryptSecret(row.app_password_encrypted as string)).toBe(INPUT.appPassword);
    expect((row.capabilities as { abilities: string[] }).abilities).toContain("novamira/run-wp-cli");
    expect(activity[0]).toMatchObject({ actor: "user-1", action: "site.connect" });
  });

  it("rejects with a friendly error when auth fails, and stores nothing", async () => {
    const { repo, sites } = memoryRepo();
    const { repo: jobs } = memoryJobsRepo();
    const mcp = async () => new MockMcpClient({ failWith: new McpAuthError("401") });
    await expect(addSite({ repo, mcp, jobs }, INPUT, "user-1")).rejects.toThrow(/application password/i);
    expect(sites).toHaveLength(0);
  });

  it("enqueues exactly one snapshot_refresh job for the new site", async () => {
    const { repo } = memoryRepo();
    const { repo: jobs, jobs: enqueued } = memoryJobsRepo();
    const mcp = async () => new MockMcpClient();

    const { id } = await addSite({ repo, mcp, jobs }, INPUT, "user-1");

    const forSite = enqueued.filter((j) => j.type === "snapshot_refresh" && j.site_id === id);
    expect(forSite).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  it("does not fail the connect when enqueueing the initial refresh fails", async () => {
    const { repo, sites } = memoryRepo();
    const { repo: jobs } = memoryJobsRepo({ failInsert: true });
    const mcp = async () => new MockMcpClient();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { id } = await addSite({ repo, mcp, jobs }, INPUT, "user-1");

    expect(id).toBe("site-1");
    expect(sites).toHaveLength(1);
    // The site is created and connected — the failure is surfaced, not
    // silent, but it must not be mistaken for the connect itself failing.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("testSiteConnection", () => {
  it("marks reconnect_needed on auth failure", async () => {
    const { repo, sites } = memoryRepo();
    const { repo: jobs } = memoryJobsRepo();
    await addSite({ repo, mcp: async () => new MockMcpClient(), jobs }, INPUT, "user-1");
    const failing = async () => new MockMcpClient({ failWith: new McpAuthError("401") });
    const res = await testSiteConnection({ repo, mcp: failing, jobs }, "site-1", "user-1");
    expect(res).toMatchObject({ ok: false, status: "reconnect_needed" });
    expect(sites[0].status).toBe("reconnect_needed");
  });

  it("marks degraded on connection failure and connected on success", async () => {
    const { repo, sites } = memoryRepo();
    const { repo: jobs } = memoryJobsRepo();
    await addSite({ repo, mcp: async () => new MockMcpClient(), jobs }, INPUT, "user-1");
    const down = async () => new MockMcpClient({ failWith: new McpConnectionError("ENOTFOUND") });
    expect((await testSiteConnection({ repo, mcp: down, jobs }, "site-1", "u")).status).toBe("degraded");
    expect((await testSiteConnection({ repo, mcp: async () => new MockMcpClient(), jobs }, "site-1", "u")).status)
      .toBe("connected");
    expect(sites[0].status).toBe("connected");
  });
});
