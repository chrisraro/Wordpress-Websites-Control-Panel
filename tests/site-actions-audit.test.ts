import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A site action that already succeeded must not report failure because the
// activity-log write afterwards threw: the operator would retry and run the
// scan / report / revoke twice. The audit is written in its own try/catch,
// logged, and never changes the result (root-file-actions.ts logActivity).
// hardenSiteAction's follow-up rescan must not fail silently either.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => ({}),
}));
vi.mock("@/lib/authz/server", () => ({
  checkPermission: async () => ({ ok: true }),
  checkSiteAccess: async () => ({ ok: true }),
  isDenied: () => false,
}));
vi.mock("@/lib/mcp/client", () => ({ createSiteMcpClient: () => { throw new Error("no MCP in tests"); } }));

const insertActivity = vi.fn();
vi.mock("@/services/sites/repo", () => ({ supabaseSitesRepo: () => ({ insertActivity }) }));
vi.mock("@/services/inventory/repo", () => ({
  supabaseAdminUsersRepo: () => ({}), supabaseSnapshotsRepo: () => ({}),
}));
const latestChecks = vi.fn();
vi.mock("@/services/security/repo", () => ({ supabaseSecurityRepo: () => ({ latestChecks }) }));
const securityScan = vi.fn();
vi.mock("@/services/security/scan", () => ({ securityScan: (...a: unknown[]) => securityScan(...a) }));
const hardenSite = vi.fn();
vi.mock("@/services/security/harden", () => ({
  hardenSite: (...a: unknown[]) => hardenSite(...a),
  hardeningPlan: () => [{ id: "fix-1" }],
  summarizeHardening: () => ({ message: "Applied 1 fix." }),
}));

const generateReport = vi.fn();
vi.mock("@/services/reports/generate", () => ({ generateReport: (...a: unknown[]) => generateReport(...a) }));
const revoke = vi.fn();
vi.mock("@/services/reports/repo", () => ({
  supabaseReportsRepo: () => ({ revoke }), supabaseReportStorage: () => ({}),
}));
vi.mock("@/services/seo/repo", () => ({ supabaseSeoRepo: () => ({}) }));
vi.mock("@/services/geogrid/repo", () => ({ supabaseGeoGridRepo: () => ({}) }));

import { runSecurityScanAction, hardenSiteAction } from "@/app/(dashboard)/sites/[id]/security-actions";
import { generateReportAction, revokeReportAction } from "@/app/(dashboard)/sites/[id]/reports-actions";

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const m of [insertActivity, latestChecks, securityScan, hardenSite, generateReport, revoke]) m.mockReset();
  insertActivity.mockRejectedValue(new Error("activity insert failed"));
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

function reportForm(): FormData {
  const fd = new FormData();
  fd.append("sections", "security");
  fd.append("period_days", "30");
  return fd;
}

describe("audit failure after a successful action", () => {
  it("runSecurityScanAction still reports ok and logs the audit error", async () => {
    securityScan.mockResolvedValue(undefined);
    const res = await runSecurityScanAction("s1");
    expect(res).toEqual({ ok: true });
    expect(insertActivity).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("runSecurityScanAction still reports a genuine scan failure", async () => {
    securityScan.mockRejectedValue(new Error("site down"));
    const res = await runSecurityScanAction("s1");
    expect(res.ok).toBe(false);
    expect(insertActivity).not.toHaveBeenCalled();
  });

  it("generateReportAction still reports ok and logs the audit error", async () => {
    generateReport.mockResolvedValue(undefined);
    const res = await generateReportAction("s1", null, reportForm());
    expect(res).toEqual({ ok: true });
    expect(errSpy).toHaveBeenCalled();
  });

  it("revokeReportAction still reports ok and logs the audit error", async () => {
    revoke.mockResolvedValue(undefined);
    const res = await revokeReportAction("s1", "r1");
    expect(res).toEqual({ ok: true });
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("hardenSiteAction rescan", () => {
  it("logs a failed rescan and says so in the returned message", async () => {
    latestChecks.mockResolvedValue({ checks: [] });
    hardenSite.mockResolvedValue({ ok: true, results: [{ id: "fix-1", ok: true }] });
    securityScan.mockRejectedValue(new Error("site timed out"));
    const res = await hardenSiteAction("s1");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/Applied 1 fix\..*rescan failed: site timed out/);
    expect(errSpy).toHaveBeenCalled();
  });

  it("leaves the message alone when the rescan succeeds", async () => {
    latestChecks.mockResolvedValue({ checks: [] });
    hardenSite.mockResolvedValue({ ok: true, results: [{ id: "fix-1", ok: true }] });
    securityScan.mockResolvedValue(undefined);
    const res = await hardenSiteAction("s1");
    expect(res.message).toBe("Applied 1 fix.");
  });
});
