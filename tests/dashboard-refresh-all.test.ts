import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteRow } from "@/services/sites/types";

// refreshAllInventoryAction (src/app/(dashboard)/dashboard/actions.ts) is the
// "Refresh all inventory" control on the dashboard: it must enqueue
// snapshot_refresh only for sites the viewer can both see AND manage, skip
// disabled sites (matching the nightly fan-out in
// src/app/api/cron/enqueue/route.ts), and report the count it actually
// enqueued -- never a promise of what it "would" do.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => ({}),
}));

const checkPermissionMock = vi.fn();
vi.mock("@/lib/authz/server", () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
  isDenied: (x: unknown): boolean =>
    typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));

vi.mock("@/services/sites/repo", () => ({ supabaseSitesRepo: () => ({}) }));
vi.mock("@/services/jobs/repo", () => ({ supabaseJobsRepo: () => ({}) }));
vi.mock("@/lib/mcp/client", () => ({
  createSiteMcpClient: () => { throw new Error("must not connect to MCP from an enqueue-only action"); },
}));

const listSitesForViewerMock = vi.fn();
vi.mock("@/services/sites/service", () => ({
  listSitesForViewer: (...args: unknown[]) => listSitesForViewerMock(...args),
}));

const enqueueJobMock = vi.fn();
vi.mock("@/services/jobs/service", () => ({
  enqueueJob: (...args: unknown[]) => enqueueJobMock(...args),
}));

// Imported after the mocks above so the action module picks up the mocked
// dependencies.
import { refreshAllInventoryAction } from "@/app/(dashboard)/dashboard/actions";

const DENIED = { ok: false, error: "You do not have permission to do that." };

function site(id: string, status: SiteRow["status"] = "connected"): SiteRow {
  return { id, status } as SiteRow;
}

const ADMIN_VIEWER = {
  id: "u1", email: "u1@example.com", role: "admin",
  permissions: new Set(["sites.view_all", "wp_toolkit.manage"]),
  grants: new Map(),
};

beforeEach(() => {
  checkPermissionMock.mockReset();
  listSitesForViewerMock.mockReset();
  enqueueJobMock.mockReset();
});

describe("refreshAllInventoryAction", () => {
  it("is refused without wp_toolkit.manage, and never lists or enqueues anything", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await refreshAllInventoryAction();
    expect(result).toEqual(DENIED);
    expect(listSitesForViewerMock).not.toHaveBeenCalled();
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it("enqueues only for visible, manage-level, non-disabled sites", async () => {
    // A client-shaped viewer: wp_toolkit.manage by override (the scenario
    // refreshInventoryAction's own comment describes), "manage" on s1,
    // read-only on s2, no grant at all on s3.
    const viewer = {
      id: "u2", email: "u2@example.com", role: "client",
      permissions: new Set(["wp_toolkit.manage"]),
      grants: new Map([["s1", "manage"], ["s2", "read"]]),
    };
    checkPermissionMock.mockResolvedValue(viewer);
    listSitesForViewerMock.mockResolvedValue([
      site("s1", "connected"),
      site("s2", "connected"),
      site("s4", "disabled"), // hypothetically visible but disabled
    ]);
    enqueueJobMock.mockResolvedValue({ id: "job-1" });

    const result = await refreshAllInventoryAction();

    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueJobMock).toHaveBeenCalledWith(
      expect.anything(), "snapshot_refresh", "s1", {}, { dedupe: true },
    );
    expect(result).toEqual({ ok: true, message: "Queued inventory refresh for 1 site." });
  });

  it("skips disabled sites even for a viewer who can see and manage everything", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([
      site("s1", "connected"),
      site("s2", "disabled"),
      site("s3", "degraded"),
    ]);
    enqueueJobMock.mockResolvedValue({ id: "job-1" });

    await refreshAllInventoryAction();

    const enqueuedSiteIds = enqueueJobMock.mock.calls.map((c) => c[2]);
    expect(enqueuedSiteIds.sort()).toEqual(["s1", "s3"]);
  });

  it("reports the real count when dedupe means fewer jobs were created than sites targeted", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([
      site("s1"), site("s2"), site("s3"),
    ]);
    // Simulate enqueueJob's own dedupe: the second site already has a
    // pending job, so it returns null instead of a new job id.
    enqueueJobMock
      .mockResolvedValueOnce({ id: "job-1" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "job-3" });

    const result = await refreshAllInventoryAction();

    expect(enqueueJobMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ok: true,
      message: "Queued inventory refresh for 2 sites (1 already had one pending).",
    });
  });

  it("reports nothing new queued when every eligible site already has a refresh pending", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("s1"), site("s2")]);
    enqueueJobMock.mockResolvedValue(null);

    const result = await refreshAllInventoryAction();

    expect(result).toEqual({
      ok: true,
      message: "Already queued — every eligible site already has a refresh pending.",
    });
  });

  it("refuses cleanly when no site is eligible at all", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("s1", "disabled")]);

    const result = await refreshAllInventoryAction();

    expect(result).toEqual({ ok: false, error: "No sites are eligible for a refresh." });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});
