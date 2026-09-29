import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteRow } from "@/services/sites/types";
import type { LiveJob } from "@/services/manage/held-jobs";

// The dashboard's fleet runs (update plugins, harden) skip a site that
// already has a live job of the same type -- two concurrent upgrader passes
// corrupt a site. When that job is held for a maintenance window days ahead,
// the skip must say when it is scheduled (not "pending from an earlier
// run"), and where to cancel it to run now.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => ({}),
}));
vi.mock("@/lib/authz/server", () => ({
  checkPermission: () => Promise.resolve({
    id: "u1", email: "u1@example.com", role: "admin",
    permissions: new Set(["sites.view_all", "wp_toolkit.manage"]), grants: new Map(),
  }),
  isDenied: () => false,
}));
vi.mock("@/services/sites/repo", () => ({ supabaseSitesRepo: () => ({}) }));
vi.mock("@/lib/mcp/client", () => ({ createSiteMcpClient: () => { throw new Error("no MCP"); } }));

const pendingExistsMock = vi.fn();
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({ pendingExists: (...a: unknown[]) => pendingExistsMock(...a) }),
}));
vi.mock("@/services/inventory/repo", () => ({
  supabaseSnapshotsRepo: () => ({
    latestSnapshot: async () => ({ taken_at: "x", payload: { plugins: [{ file: "p", update: "available" }], themes: [] } }),
  }),
}));
vi.mock("@/services/security/repo", () => ({
  supabaseSecurityRepo: () => ({
    latestChecks: async () => ({ runAt: "x", checks: [{ check_id: "xmlrpc_enabled", result: "warn" }] }),
  }),
}));
const listSitesMock = vi.fn();
vi.mock("@/services/sites/service", () => ({ listSitesForViewer: (...a: unknown[]) => listSitesMock(...a) }));
const enqueueBatchMock = vi.fn();
vi.mock("@/services/jobs/service", () => ({
  enqueueJob: vi.fn(), enqueueBatch: (...a: unknown[]) => enqueueBatchMock(...a),
}));

const liveJobMock = vi.fn();
const getWindowMock = vi.fn();
vi.mock("@/services/manage/held-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/manage/held-jobs")>()),
  supabaseHeldJobsDeps: () => ({
    liveJob: (...a: unknown[]) => liveJobMock(...a),
    getWindow: (...a: unknown[]) => getWindowMock(...a),
  }),
}));

import { hardenFleetAction, updateAllPluginsAction } from "@/app/(dashboard)/dashboard/actions";

const site = (id: string, name: string) =>
  ({ id, name, status: "connected", url: `https://${id}.example.com`, client_label: null }) as SiteRow;

/** Far enough ahead to be in the future whenever this test runs. */
const FUTURE = "2099-10-02T17:00:00Z"; // Fri 2 Oct 2099 17:00 UTC = Sat 3 Oct, 01:00 in Manila
const HELD: LiveJob = { id: "j1", status: "pending", scheduled_for: FUTURE, batch_id: "b-held" };

beforeEach(() => {
  pendingExistsMock.mockReset().mockImplementation(async (_t: string, id: string) => id === "busy");
  listSitesMock.mockReset().mockResolvedValue([site("busy", "Acme Co")]);
  enqueueBatchMock.mockReset().mockResolvedValue({ batchId: "b-new", count: 1 });
  liveJobMock.mockReset().mockResolvedValue(HELD);
  getWindowMock.mockReset().mockResolvedValue({
    days: [6], start: "01:00", durationMinutes: 120, timeZone: "Asia/Manila",
  });
});

describe.each([
  ["updateAllPluginsAction", updateAllPluginsAction, "update_all_plugins"],
  ["hardenFleetAction", hardenFleetAction, "harden"],
] as const)("%s held-job skip message", (_name, action, type) => {
  it("says when a window-held job is scheduled and where to cancel it", async () => {
    const r = (await action("production"))!;
    expect(r.ok).toBe(false);
    expect(liveJobMock).toHaveBeenCalledWith(type, "busy");
    expect(r.error).toContain("Acme Co already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)");
    expect(r.error).toContain("/marketplace/batches/b-held");
    expect(r.error).not.toMatch(/earlier run/);
    expect(enqueueBatchMock).not.toHaveBeenCalled();
  });

  it("shows UTC when the site has no maintenance window", async () => {
    getWindowMock.mockResolvedValue(null);
    const r = (await action("production"))!;
    expect(r.error).toContain("already scheduled for Fri 2 Oct, 17:00 UTC");
  });

  it("says already running for a job that is executing, with no cancel link", async () => {
    liveJobMock.mockResolvedValue({ ...HELD, status: "running" });
    const r = (await action("production"))!;
    expect(r.error).toContain("Acme Co already running");
    expect(r.error).not.toContain("/marketplace/batches/");
  });

  it("names the held site when other sites were queued", async () => {
    listSitesMock.mockResolvedValue([site("busy", "Acme Co"), site("free", "Beta")]);
    const r = (await action("production"))!;
    expect(r.ok).toBe(true);
    expect(enqueueBatchMock.mock.calls[0][2]).toEqual(["free"]);
    expect(r.message).toContain("1 already had a run pending");
    expect(r.message).toContain("Acme Co already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)");
  });

  it("does not look anything up when no site was skipped", async () => {
    pendingExistsMock.mockResolvedValue(false);
    await action("production");
    expect(liveJobMock).not.toHaveBeenCalled();
  });
});
