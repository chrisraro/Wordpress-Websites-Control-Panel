import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { securityScan, isFinalScanAttempt, type ScanDeps } from "@/services/security/scan";
import { computeRetryDelayMs } from "@/services/jobs/service";
import type { SecurityRepo, OpenVuln } from "@/services/security/repo";
import type { SitesRepo } from "@/services/sites/repo";
import type { AdminUsersRepo, SnapshotsRepo } from "@/services/inventory/repo";
import type { InventoryPayload } from "@/services/inventory/types";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";

// Audit 2026-09-29, still-open #3: the security_scan job retries 3 times in
// ~6 minutes, and every failed attempt called recordScanResult(false) -- so
// one outage walked a site straight to `degraded` (3 consecutive failures).
// Only a terminal failure may count.

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

const INV: InventoryPayload = {
  collected_at: "2026-09-28T00:00:00Z", wp_version: "6.4.1", php_version: "8.2",
  admin_url: "https://example.com/wp-admin/", core_update: null, plugins: [], themes: [],
};

async function deps(opts: { mcpFails?: boolean; recordFails?: boolean } = {}) {
  const recorded: boolean[] = [];
  const security: SecurityRepo = {
    async replaceFeed() { return 0; },
    async hasFeedEntries() { return false; },
    async newestFeedUpdatedAt() { return null; },
    async feedEntriesForSlugs() { return []; },
    async syncSiteVulns() {},
    async openVulns() { return [] as OpenVuln[]; },
    async insertChecks() {},
    async latestChecks() { return null; },
    async latestGrade() { return null; },
    async insertUptime() {},
    async uptimeSummary() { return { latestOk: true, responseMs: 1, sslDays: 90, uptime24h: 100 }; },
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
    async recordScanResult(_id: string, success: boolean) {
      recorded.push(success);
      if (opts.recordFails) throw new Error("sites update failed: connection reset");
    },
  } as unknown as SitesRepo;
  const snapshots: SnapshotsRepo = {
    async insertSnapshot() {},
    async latestSnapshot() { return { payload: INV, taken_at: "" }; },
  };
  const adminUsers: AdminUsersRepo = { async upsertAdminUsers() {}, async latestAdminUsers() { return null; } };
  const mcp = async () => {
    if (opts.mcpFails) throw new Error("site unreachable");
    return new MockMcpClient({
      handler: (_n, args) => {
        const code = (args as { code: string }).code;
        const value = code.includes("core/checksums")
          ? { ok: true, checked: 1, mismatched: [], missing: [], unknown: [] }
          : [{ check_id: "wp_debug", result: "pass" }];
        return { success: true, data: { success: true, return_value: JSON.stringify(value) } };
      },
    });
  };
  const fetchImpl = (async () => new Response("", { status: 403, headers: { "x-frame-options": "DENY" } })) as typeof fetch;
  const d: ScanDeps = { sites, snapshots, adminUsers, security, mcp, fetchImpl };
  return { d, recorded };
}

describe("securityScan failure counting", () => {
  it("does not count a failure on an attempt that will be retried", async () => {
    const { d, recorded } = await deps({ mcpFails: true });
    await expect(securityScan(d, "site-1", { recordFailure: false })).rejects.toThrow("site unreachable");
    expect(recorded).toEqual([]);
  });

  it("counts a terminal failure", async () => {
    const { d, recorded } = await deps({ mcpFails: true });
    await expect(securityScan(d, "site-1", { recordFailure: true })).rejects.toThrow("site unreachable");
    expect(recorded).toEqual([false]);
  });

  it("counts by default, so one-shot callers (the manual scan button) are terminal", async () => {
    const { d, recorded } = await deps({ mcpFails: true });
    await expect(securityScan(d, "site-1")).rejects.toThrow();
    expect(recorded).toEqual([false]);
  });

  it("a successful scan whose success bookkeeping fails is still a success, never a failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d, recorded } = await deps({ recordFails: true });
    const res = await securityScan(d, "site-1");
    expect(res.grade.grade).toBeDefined();
    // Recorded true once; the throw did not fall through to recordScanResult(false).
    expect(recorded).toEqual([true]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("isFinalScanAttempt", () => {
  it("is true exactly when the job ladder will not retry", () => {
    for (const attempts of [0, 1, 2, 3, 4]) {
      expect(isFinalScanAttempt(attempts)).toBe(computeRetryDelayMs(attempts) === null);
    }
    expect(isFinalScanAttempt(1)).toBe(false);
    expect(isFinalScanAttempt(2)).toBe(false);
    expect(isFinalScanAttempt(3)).toBe(true);
  });
});
