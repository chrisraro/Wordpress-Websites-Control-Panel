import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { securityScan, refreshVulnFeed, type ScanDeps } from "@/services/security/scan";
import type { SecurityRepo, OpenVuln } from "@/services/security/repo";
import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import type { SecurityCheck } from "@/services/security/types";
import type { SitesRepo } from "@/services/sites/repo";
import type { AdminUsersRepo, SnapshotsRepo } from "@/services/inventory/repo";
import type { InventoryPayload } from "@/services/inventory/types";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => { delete process.env.WORDFENCE_API_KEY; });

const INV: InventoryPayload = {
  collected_at: "2026-08-28T00:00:00Z", wp_version: "6.4.1", php_version: "8.2",
  admin_url: "https://example.com/wp-admin/",
  core_update: null,
  plugins: [{ file: "akismet/akismet.php", name: "akismet", version: "5.3", status: "active", update: "none", update_version: null }],
  themes: [],
};

const FEED: FeedEntry[] = [{
  id: "v1:plugin:akismet", title: "Akismet XSS", cve: null, cvss: 9.5,
  software_type: "plugin", software_slug: "akismet",
  affected_versions: [{ from_version: "*", from_inclusive: true, to_version: "5.3.9", to_inclusive: true }],
  fixed_in: "5.4",
}];

function fakeSecurityRepo(feed: FeedEntry[]) {
  const state = {
    feed, synced: [] as unknown[], inserted: [] as Array<{ runAt: string; checks: SecurityCheck[] }>,
  };
  const repo: SecurityRepo = {
    async replaceFeed(entries) { state.feed = entries; return entries.length; },
    async hasFeedEntries() { return state.feed.length > 0; },
    async feedEntriesForSlugs() { return state.feed; },
    async syncSiteVulns(_s, matches) { state.synced = matches; },
    async openVulns() {
      return state.synced.map((m) => ({ ...(m as OpenVuln), title: "t", cve: null, fixed_in: null, first_seen: "" }));
    },
    async insertChecks(_s, runAt, checks) { state.inserted.push({ runAt, checks }); },
    async latestChecks() { return null; },
    async latestGrade() { return null; },
    async insertUptime() {},
    async uptimeSummary() { return { latestOk: true, responseMs: 200, sslDays: 90, uptime24h: 100 }; },
  };
  return { repo, state };
}

function fakeSites() {
  const scanResults: boolean[] = [];
  let encrypted = "";
  const sites = {
    async getSite(id: string) {
      return id === "site-1"
        ? { id, name: "S", url: "https://site.test", mcp_endpoint: "https://site.test/wp-json/mcp/novamira",
            wp_username: "admin", status: "connected", client_label: null,
            capabilities: { abilities: [] }, created_at: "", updated_at: "" }
        : null;
    },
    async getSiteCredentials() {
      return { mcp_endpoint: "https://site.test/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: encrypted };
    },
    async recordScanResult(_id: string, success: boolean) { scanResults.push(success); },
  } as unknown as SitesRepo;
  return { sites, scanResults, setCreds: (v: string) => { encrypted = v; } };
}

const snapshotsWith = (payload: InventoryPayload | null): SnapshotsRepo => ({
  async insertSnapshot() {},
  async latestSnapshot() { return payload ? { payload, taken_at: "2026-08-28T00:00:00Z" } : null; },
});

const fakeAdminUsers = (): AdminUsersRepo => ({
  async upsertAdminUsers() {},
  async latestAdminUsers() { return null; },
});

function phpClient() {
  // Serves both hardening (array) and checksums (object) snippets.
  return new MockMcpClient({
    handler: (_n, args) => {
      const code = (args as { code: string }).code;
      const value = code.includes("core/checksums")
        ? { ok: true, checked: 100, mismatched: [], missing: [] }
        : [{ check_id: "wp_debug", result: "pass" }];
      return { success: true, data: { success: true, return_value: JSON.stringify(value) } };
    },
  });
}

const okFetch = (async () => new Response("", { status: 403, headers: { "x-frame-options": "DENY" } })) as typeof fetch;

describe("securityScan", () => {
  it("matches vulns, runs checks, stores a grade row, records success", async () => {
    const sec = fakeSecurityRepo(FEED);
    const f = fakeSites();
    f.setCreds(await encryptSecret("pass"));
    const deps: ScanDeps = {
      sites: f.sites, snapshots: snapshotsWith(INV), adminUsers: fakeAdminUsers(), security: sec.repo,
      mcp: async () => phpClient(), fetchImpl: okFetch,
    };
    const res = await securityScan(deps, "site-1");
    expect(res.vulnCount).toBe(1);
    expect(res.grade.grade).toBeDefined();
    // critical vuln (-30) dominates; base checks mostly pass
    expect(res.grade.score).toBeLessThanOrEqual(70);
    const run = sec.state.inserted[0];
    expect(run.checks.find((c) => c.check_id === "grade")?.details).toMatchObject({ grade: res.grade.grade });
    expect(run.checks.find((c) => c.check_id === "core_checksums")?.result).toBe("pass");
    expect(f.scanResults).toEqual([true]);
  });

  it("records a wordfence_feed warn check when the feed cache is empty", async () => {
    const sec = fakeSecurityRepo([]);
    const f = fakeSites();
    f.setCreds(await encryptSecret("pass"));
    const deps: ScanDeps = {
      sites: f.sites, snapshots: snapshotsWith(INV), adminUsers: fakeAdminUsers(), security: sec.repo,
      mcp: async () => phpClient(), fetchImpl: okFetch,
    };
    const res = await securityScan(deps, "site-1");
    expect(res.vulnCount).toBe(0);
    expect(sec.state.inserted[0].checks.find((c) => c.check_id === "wordfence_feed")?.result).toBe("warn");
  });

  it("records failure on error and rethrows", async () => {
    const sec = fakeSecurityRepo(FEED);
    const f = fakeSites();
    f.setCreds(await encryptSecret("pass"));
    const deps: ScanDeps = {
      sites: f.sites, snapshots: snapshotsWith(INV), adminUsers: fakeAdminUsers(), security: sec.repo,
      mcp: async () => { throw new Error("unreachable"); }, fetchImpl: okFetch,
    };
    await expect(securityScan(deps, "site-1")).rejects.toThrow("unreachable");
    expect(f.scanResults).toEqual([false]);
  });
});

describe("refreshVulnFeed", () => {
  it("skips without a key", async () => {
    const sec = fakeSecurityRepo([]);
    expect(await refreshVulnFeed(sec.repo)).toEqual({ updated: 0, skipped: true });
  });
  it("fetches and stores with a key", async () => {
    process.env.WORDFENCE_API_KEY = "k";
    const sec = fakeSecurityRepo([]);
    const feedJson = {
      "u1": { id: "u1", title: "T", cve: null, cvss: { score: 5 }, software: [{
        type: "plugin", slug: "x",
        affected_versions: { "r": { from_version: "*", from_inclusive: true, to_version: "1.0", to_inclusive: true } },
        patched_versions: ["1.1"],
      }]},
    };
    const fetchImpl = (async () => new Response(JSON.stringify(feedJson), { status: 200 })) as typeof fetch;
    const res = await refreshVulnFeed(sec.repo, fetchImpl);
    expect(res).toEqual({ updated: 1, skipped: false });
    expect(sec.state.feed[0].software_slug).toBe("x");
  });
});
