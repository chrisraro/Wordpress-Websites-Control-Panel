import { describe, it, expect, vi, beforeEach } from "vitest";

// dismissGlobalFailedJobsAction (src/app/(dashboard)/dashboard/actions.ts) is
// the null-site counterpart of dismissFailedGeoGridRunsAction
// (../sites/[id]/geogrid-actions.ts): it clears the "N failed" alert for a
// site-less job type on the dashboard's system-health panel. There is no
// site to check access against for these jobs, so it is gated on
// queue.process alone -- the permission that already means "you are
// responsible for the queue" (admin/developer hold it, content_writer and
// client do not) -- and a client must never reach the repo call underneath.

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

const dismissFailedMock = vi.fn();
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({ dismissFailed: (...args: unknown[]) => dismissFailedMock(...args) }),
}));

// actions.ts also imports these for refreshAllInventoryAction; stubbed so
// the module loads without pulling in real Supabase/MCP wiring.
vi.mock("@/services/sites/repo", () => ({ supabaseSitesRepo: () => ({}) }));
vi.mock("@/services/sites/service", () => ({ listSitesForViewer: vi.fn() }));
vi.mock("@/services/jobs/service", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/mcp/client", () => ({ createSiteMcpClient: () => ({}) }));

// Imported after the mocks above so the action module picks up the mocked
// dependencies.
import { dismissGlobalFailedJobsAction } from "@/app/(dashboard)/dashboard/actions";

const DENIED = { ok: false, error: "You do not have permission to do that." };

const QUEUE_PROCESS_VIEWER = {
  id: "u1", email: "u1@example.com", role: "admin",
  permissions: new Set(["queue.process"]),
  grants: new Map(),
};

beforeEach(() => {
  checkPermissionMock.mockReset();
  dismissFailedMock.mockReset();
});

describe("dismissGlobalFailedJobsAction", () => {
  it("is refused without queue.process, and never touches the repo", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);

    const result = await dismissGlobalFailedJobsAction("vuln_feed_refresh");

    expect(result).toEqual(DENIED);
    expect(dismissFailedMock).not.toHaveBeenCalled();
  });

  it("checks queue.process specifically, not some other permission", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    await dismissGlobalFailedJobsAction("vuln_feed_refresh");
    expect(checkPermissionMock).toHaveBeenCalledWith("queue.process");
  });

  it("dismisses with a null site id for the given job type when permitted", async () => {
    checkPermissionMock.mockResolvedValue(QUEUE_PROCESS_VIEWER);
    dismissFailedMock.mockResolvedValue(undefined);

    const result = await dismissGlobalFailedJobsAction("vuln_feed_refresh");

    expect(dismissFailedMock).toHaveBeenCalledWith(null, "vuln_feed_refresh");
    expect(result).toEqual({ ok: true });
  });

  it("reports the repo's error rather than throwing", async () => {
    checkPermissionMock.mockResolvedValue(QUEUE_PROCESS_VIEWER);
    dismissFailedMock.mockRejectedValue(new Error("db exploded"));

    const result = await dismissGlobalFailedJobsAction("vuln_feed_refresh");

    expect(result).toEqual({ ok: false, error: "db exploded" });
  });
});
