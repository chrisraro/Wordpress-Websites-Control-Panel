import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  computeGrade, scanCoverage, coverageGaps, COVERAGE_GAP_LABEL, type SecurityCheck,
} from "@/services/security/types";
import { securityScan, type ScanDeps } from "@/services/security/scan";
import { supabaseSecurityRepo, type SecurityRepo, type OpenVuln } from "@/services/security/repo";
import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import type { SitesRepo } from "@/services/sites/repo";
import type { AdminUsersRepo, SnapshotsRepo } from "@/services/inventory/repo";
import type { InventoryPayload } from "@/services/inventory/types";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SupabaseClient } from "@supabase/supabase-js";

// Audit 2026-09-29, still-open #2: every "could not check" costs only the 2
// points of a warn, so a scan that verified almost nothing -- no feed, no
// checksums, site unreachable from outside -- could still grade A or B. A
// grade has to say when it is partial, and a partial grade cannot be good.

const PROBES_OK: SecurityCheck[] = [
  { check_id: "xmlrpc_enabled", result: "pass", details: { status: 403 } },
  { check_id: "uploads_listing", result: "pass", details: { status: 403 } },
  { check_id: "security_headers", result: "pass", details: { status: 200 } },
];
const CHECKSUMS_OK: SecurityCheck = {
  check_id: "core_checksums", result: "pass", details: { checked: 100, mismatched: [], missing: [], unknown: [] },
};

describe("scanCoverage", () => {
  it("is complete when the feed was used, checksums ran and every probe answered", () => {
    const cov = scanCoverage([...PROBES_OK, CHECKSUMS_OK]);
    expect(cov).toEqual({ vuln_feed: true, core_checksums: true, http_probes: true });
    expect(coverageGaps(cov)).toEqual([]);
  });

  it("flags a missing or stale feed", () => {
    for (const id of ["wordfence_feed", "wordfence_feed_stale"]) {
      const cov = scanCoverage([...PROBES_OK, CHECKSUMS_OK, { check_id: id, result: "warn" }]);
      expect(coverageGaps(cov)).toEqual(["vuln_feed"]);
    }
  });

  it("flags checksums that errored or were never published, but not a genuine missing-file warn", () => {
    const errored = { check_id: "core_checksums", result: "warn" as const, details: { error: "No checksums published" } };
    expect(coverageGaps(scanCoverage([...PROBES_OK, errored]))).toEqual(["core_checksums"]);
    // Absent entirely is also "not checked".
    expect(coverageGaps(scanCoverage([...PROBES_OK]))).toEqual(["core_checksums"]);
    const realWarn = { check_id: "core_checksums", result: "warn" as const,
      details: { checked: 10, mismatched: [], missing: ["wp-admin/x.php"], unknown: [] } };
    expect(coverageGaps(scanCoverage([...PROBES_OK, realWarn]))).toEqual([]);
  });

  it("flags any unreachable probe", () => {
    const probes = PROBES_OK.map((c) =>
      c.check_id === "uploads_listing" ? { ...c, result: "warn" as const, details: { status: "unreachable" } } : c);
    expect(coverageGaps(scanCoverage([...probes, CHECKSUMS_OK]))).toEqual(["http_probes"]);
  });

  it("labels every gap in plain language", () => {
    for (const gap of ["vuln_feed", "core_checksums", "http_probes"] as const) {
      expect(COVERAGE_GAP_LABEL[gap]).toMatch(/\w/);
    }
  });
});

describe("computeGrade with coverage", () => {
  it("leaves a complete scan alone and says so", () => {
    const g = computeGrade({
      vulnSeverities: [], checks: [], uptime24h: 100,
      coverage: { vuln_feed: true, core_checksums: true, http_probes: true },
    });
    expect(g).toEqual({ grade: "A", score: 100, incomplete: [] });
  });

  it("caps an incomplete scan at C and lists what could not be checked", () => {
    // Three 2-point warns: 94 would be an A without the cap.
    const g = computeGrade({
      vulnSeverities: [], uptime24h: 100,
      checks: [
        { check_id: "wordfence_feed", result: "warn" },
        { check_id: "core_checksums", result: "warn", details: { error: "x" } },
        { check_id: "security_headers", result: "warn", details: { status: "unreachable" } },
      ],
      coverage: { vuln_feed: false, core_checksums: false, http_probes: false },
    });
    expect(g.grade).toBe("C");
    expect(g.score).toBeLessThanOrEqual(79);
    expect(g.incomplete).toEqual(["vuln_feed", "core_checksums", "http_probes"]);
  });

  it("never raises a grade that was already worse than C", () => {
    const g = computeGrade({
      vulnSeverities: ["critical", "high"], checks: [], uptime24h: 100,
      coverage: { vuln_feed: true, core_checksums: false, http_probes: true },
    });
    expect(g).toEqual({ grade: "D", score: 50, incomplete: ["core_checksums"] });
  });

  it("keeps the old shape when no coverage is given", () => {
    expect(computeGrade({ vulnSeverities: [], checks: [], uptime24h: 100 }))
      .toEqual({ grade: "A", score: 100 });
  });
});

// ---- securityScan persists coverage on the grade row ----

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

const INV: InventoryPayload = {
  collected_at: "2026-09-28T00:00:00Z", wp_version: "6.4.1", php_version: "8.2",
  admin_url: "https://example.com/wp-admin/", core_update: null,
  plugins: [], themes: [],
};
const FEED: FeedEntry[] = [{
  id: "v1:plugin:other", title: "t", cve: null, cvss: 5, software_type: "plugin", software_slug: "other",
  affected_versions: [{ from_version: "*", from_inclusive: true, to_version: "1", to_inclusive: true }],
  fixed_in: "2",
}];

async function deps(opts: { feed: FeedEntry[]; checksumsOk: boolean; fetchImpl: typeof fetch }) {
  const inserted: SecurityCheck[][] = [];
  const security: SecurityRepo = {
    async replaceFeed() { return 0; },
    async hasFeedEntries() { return opts.feed.length > 0; },
    async newestFeedUpdatedAt() { return opts.feed.length > 0 ? new Date().toISOString() : null; },
    async feedEntriesForSlugs() { return opts.feed; },
    async syncSiteVulns() {},
    async openVulns() { return [] as OpenVuln[]; },
    async insertChecks(_s, _r, checks) { inserted.push(checks); },
    async latestChecks() { return null; },
    async latestGrade() { return null; },
    async insertUptime() {},
    async uptimeSummary() { return { latestOk: true, responseMs: 200, sslDays: 90, uptime24h: 100 }; },
  };
  const encrypted = await encryptSecret("pass");
  const sites = {
    async getSite(id: string) {
      return { id, name: "S", url: "https://site.test", status: "connected", client_label: null,
        capabilities: { abilities: [] }, created_at: "", updated_at: "" };
    },
    async getSiteCredentials() {
      return { mcp_endpoint: "https://site.test/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: encrypted };
    },
    async recordScanResult() {},
  } as unknown as SitesRepo;
  const snapshots: SnapshotsRepo = {
    async insertSnapshot() {},
    async latestSnapshot() { return { payload: INV, taken_at: "2026-09-28T00:00:00Z" }; },
  };
  const adminUsers: AdminUsersRepo = { async upsertAdminUsers() {}, async latestAdminUsers() { return null; } };
  const mcp = async () => new MockMcpClient({
    handler: (_n, args) => {
      const code = (args as { code: string }).code;
      const value = code.includes("core/checksums")
        ? (opts.checksumsOk
          ? { ok: true, checked: 100, mismatched: [], missing: [], unknown: [] }
          : { ok: false, error: "No checksums published for WordPress 6.4.1 (en_US)" })
        : [{ check_id: "wp_debug", result: "pass" }];
      return { success: true, data: { success: true, return_value: JSON.stringify(value) } };
    },
  });
  const d: ScanDeps = { sites, snapshots, adminUsers, security, mcp, fetchImpl: opts.fetchImpl };
  return { d, inserted };
}

const okFetch = (async () => new Response("", { status: 403, headers: { "x-frame-options": "DENY" } })) as typeof fetch;
const deadFetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;

describe("securityScan coverage", () => {
  it("stores full coverage on the grade row of a complete scan", async () => {
    const { d, inserted } = await deps({ feed: FEED, checksumsOk: true, fetchImpl: okFetch });
    const res = await securityScan(d, "site-1");
    expect(res.grade.grade).toBe("A");
    expect(res.grade.incomplete).toEqual([]);
    const row = inserted[0].find((c) => c.check_id === "grade");
    expect(row?.details).toMatchObject({
      grade: "A", incomplete: [],
      coverage: { vuln_feed: true, core_checksums: true, http_probes: true },
    });
  });

  it("caps and marks a scan with no feed, no checksums and an unreachable site", async () => {
    const { d, inserted } = await deps({ feed: [], checksumsOk: false, fetchImpl: deadFetch });
    const res = await securityScan(d, "site-1");
    expect(res.grade.grade).toBe("C");
    expect(res.grade.incomplete).toEqual(["vuln_feed", "core_checksums", "http_probes"]);
    const row = inserted[0].find((c) => c.check_id === "grade");
    expect(row?.details).toMatchObject({
      grade: "C", incomplete: ["vuln_feed", "core_checksums", "http_probes"],
      coverage: { vuln_feed: false, core_checksums: false, http_probes: false },
    });
  });
});

// ---- latestGrade reads it back ----

function gradeDb(details: unknown): SupabaseClient {
  const chain = {
    select() { return chain; }, eq() { return chain; }, order() { return chain; }, limit() { return chain; },
    async maybeSingle() { return { data: details === undefined ? null : { details }, error: null }; },
  };
  return { from() { return chain; } } as unknown as SupabaseClient;
}

describe("latestGrade coverage", () => {
  it("returns the stored incomplete list", async () => {
    const repo = supabaseSecurityRepo(gradeDb({ grade: "C", score: 79, incomplete: ["vuln_feed", "bogus"] }));
    // Unknown entries are dropped rather than rendered as raw ids.
    expect(await repo.latestGrade("s")).toEqual({ grade: "C", score: 79, incomplete: ["vuln_feed"] });
  });

  it("leaves grades from before coverage tracking unmarked", async () => {
    const repo = supabaseSecurityRepo(gradeDb({ grade: "A", score: 96 }));
    expect(await repo.latestGrade("s")).toEqual({ grade: "A", score: 96 });
  });
});
