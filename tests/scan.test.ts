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

function fakeSecurityRepo(feed: FeedEntry[], feedUpdatedAt: string | null = null) {
  const state = {
    feed, synced: [] as unknown[], inserted: [] as Array<{ runAt: string; checks: SecurityCheck[] }>,
    feedUpdatedAt,
  };
  const repo: SecurityRepo = {
    async replaceFeed(entries) {
      state.feed = entries;
      state.feedUpdatedAt = new Date().toISOString();
      return entries.length;
    },
    async hasFeedEntries() { return state.feed.length > 0; },
    async newestFeedUpdatedAt() { return state.feedUpdatedAt; },
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

  it("records a wordfence_feed_stale warn check when the cached feed is stale", async () => {
    // 60h deliberately, not 48h: Math.round(60h/24) would print "3d" and
    // overstate the age; formatAge must Math.floor so 60h prints "2d ago".
    const staleAt = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString(); // 60h old
    const sec = fakeSecurityRepo(FEED, staleAt);
    const f = fakeSites();
    f.setCreds(await encryptSecret("pass"));
    const deps: ScanDeps = {
      sites: f.sites, snapshots: snapshotsWith(INV), adminUsers: fakeAdminUsers(), security: sec.repo,
      mcp: async () => phpClient(), fetchImpl: okFetch,
    };
    const res = await securityScan(deps, "site-1");
    expect(res.vulnCount).toBe(1);
    // Distinct check_id from the absent-feed case: the page renders
    // check_id -> label with no access to `details`, so these must be
    // separately queryable/displayable — see CHECK_LABELS in
    // src/app/(dashboard)/sites/[id]/security/page.tsx.
    const warn = sec.state.inserted[0].checks.find((c) => c.check_id === "wordfence_feed_stale");
    expect(warn?.result).toBe("warn");
    expect(sec.state.inserted[0].checks.find((c) => c.check_id === "wordfence_feed")).toBeUndefined();
    expect((warn?.details as { message: string }).message).toBe(
      "Vulnerability feed is stale — last refreshed 2d ago.",
    );
  });

  it("does not warn when the cached feed is fresh", async () => {
    const freshAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h old
    const sec = fakeSecurityRepo(FEED, freshAt);
    const f = fakeSites();
    f.setCreds(await encryptSecret("pass"));
    const deps: ScanDeps = {
      sites: f.sites, snapshots: snapshotsWith(INV), adminUsers: fakeAdminUsers(), security: sec.repo,
      mcp: async () => phpClient(), fetchImpl: okFetch,
    };
    const res = await securityScan(deps, "site-1");
    expect(res.vulnCount).toBe(1);
    expect(sec.state.inserted[0].checks.find((c) => c.check_id === "wordfence_feed")).toBeUndefined();
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

  it("refetches even when the cached feed was written moments ago", async () => {
    // There is no freshness guard any more, and this pins its absence.
    //
    // The guard skipped when the newest row was under 12h old, which tests
    // whether some rows are RECENT, not whether the feed is COMPLETE. In
    // production a run died on chunk 8 of 87 with 4,000 of 43,060 rows
    // written; the next job saw a 34-minute-old timestamp, skipped, and
    // reported success in 0.4s, leaving the feed 9% populated while security
    // scans graded against it.
    process.env.WORDFENCE_API_KEY = "k";
    const freshAt = new Date(Date.now() - 60 * 1000).toISOString(); // a minute old
    const sec = fakeSecurityRepo(FEED, freshAt);
    let called = false;
    const feedJson = {
      "u1": { id: "u1", title: "T", cve: null, cvss: { score: 5 }, software: [{
        type: "plugin", slug: "x",
        affected_versions: { "r": { from_version: "*", from_inclusive: true, to_version: "1.0", to_inclusive: true } },
        patched_versions: ["1.1"],
      }]},
    };
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify(feedJson), { status: 200 });
    }) as typeof fetch;

    const res = await refreshVulnFeed(sec.repo, fetchImpl);
    expect(called).toBe(true);
    expect(res).toEqual({ updated: 1, skipped: false });
  });

  it("a fresh job after a PREVIOUS job's partial write still refetches", async () => {
    // The exact production incident. The old guard was scoped to retries of
    // the same job (allowSkip: false on attempts > 1), so it was a brand-new
    // job -- the case not covered -- that walked into the trap.
    process.env.WORDFENCE_API_KEY = "k";
    const sec = fakeSecurityRepo([]);
    let calls = 0;
    sec.repo.replaceFeed = async (entries) => {
      calls += 1;
      if (calls === 1) {
        // Chunks commit and stamp updated_at before a later chunk throws.
        sec.state.feedUpdatedAt = new Date().toISOString();
        throw new Error("vuln_feed upsert failed: ON CONFLICT DO UPDATE command cannot affect row a second time");
      }
      sec.state.feed = entries;
      sec.state.feedUpdatedAt = new Date().toISOString();
      return entries.length;
    };
    const feedJson = {
      "u1": { id: "u1", title: "T", cve: null, cvss: { score: 5 }, software: [{
        type: "plugin", slug: "x",
        affected_versions: { "r": { from_version: "*", from_inclusive: true, to_version: "1.0", to_inclusive: true } },
        patched_versions: ["1.1"],
      }]},
    };
    const fetchImpl = (async () => new Response(JSON.stringify(feedJson), { status: 200 })) as typeof fetch;

    // Job 1 dies partway, leaving the feed fresh-looking but incomplete.
    await expect(refreshVulnFeed(sec.repo, fetchImpl)).rejects.toThrow(/cannot affect row a second time/);

    // Job 2 is a NEW job, not a retry. It must still refetch.
    const second = await refreshVulnFeed(sec.repo, fetchImpl);
    expect(second).toEqual({ updated: 1, skipped: false });
    expect(calls).toBe(2);
  });

  it("still skips, honestly, when no key is configured", async () => {
    delete process.env.WORDFENCE_API_KEY;
    const sec = fakeSecurityRepo(FEED, new Date().toISOString());
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    expect(await refreshVulnFeed(sec.repo, fetchImpl)).toEqual({ updated: 0, skipped: true });
    expect(called).toBe(false);
  });
});
