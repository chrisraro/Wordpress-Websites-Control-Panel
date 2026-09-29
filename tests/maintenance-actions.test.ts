import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteRow } from "@/services/sites/types";
import type { MaintenanceWindow } from "@/services/maintenance/window";

// Maintenance windows touch three action surfaces:
//   - setMaintenanceWindowAction: edits the site record -> sites.manage plus a
//     manage grant, zod-validated, never reaching the database when denied;
//   - updateAllPluginsAction / hardenFleetAction: "In each site's
//     maintenance window" sets scheduled_for per site, sites without a window
//     run now, and "now" never even reads the windows;
//   - bulkAction: the same choice for one site's selected updates.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const createServiceSupabaseMock = vi.fn(() => ({}));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => createServiceSupabaseMock(),
}));

const DENIED = { ok: false, error: "You do not have permission to do that." };
const checkPermissionMock = vi.fn();
const checkSiteAccessMock = vi.fn();
vi.mock("@/lib/authz/server", () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
  checkSiteAccess: (...args: unknown[]) => checkSiteAccessMock(...args),
  isDenied: (x: unknown): boolean =>
    typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));

const insertActivity = vi.fn();
vi.mock("@/services/sites/repo", () => ({
  supabaseSitesRepo: () => ({ insertActivity: (e: unknown) => insertActivity(e) }),
}));
vi.mock("@/lib/mcp/client", () => ({
  createSiteMcpClient: () => { throw new Error("must not connect to MCP from an enqueue-only action"); },
}));
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({ pendingExists: () => Promise.resolve(false) }),
}));

const SAT_1AM: MaintenanceWindow = { days: [6], start: "01:00", durationMinutes: 120, timeZone: "Asia/Manila" };
const setWindow = vi.fn();
const listWindows = vi.fn();
vi.mock("@/services/maintenance/repo", () => ({
  supabaseMaintenanceRepo: () => ({
    setWindow: (...a: unknown[]) => setWindow(...a),
    listWindows: (...a: unknown[]) => listWindows(...a),
    getWindow: () => Promise.resolve(null),
  }),
}));

const latestSnapshotMock = vi.fn();
vi.mock("@/services/inventory/repo", () => ({
  supabaseSnapshotsRepo: () => ({ latestSnapshot: (...a: unknown[]) => latestSnapshotMock(...a) }),
}));
vi.mock("@/services/security/repo", () => ({
  supabaseSecurityRepo: () => ({ latestChecks: () => Promise.resolve(null) }),
}));

const listSitesForViewerMock = vi.fn();
vi.mock("@/services/sites/service", () => ({
  listSitesForViewer: (...args: unknown[]) => listSitesForViewerMock(...args),
}));

const enqueueBatchMock = vi.fn();
vi.mock("@/services/jobs/service", () => ({
  enqueueJob: vi.fn(),
  enqueueBatch: (...args: unknown[]) => enqueueBatchMock(...args),
}));

const enqueueBulkMock = vi.fn();
vi.mock("@/services/bulk/service", () => ({
  enqueueBulk: (...args: unknown[]) => enqueueBulkMock(...args),
}));

import { setMaintenanceWindowAction } from "@/app/(dashboard)/sites/[id]/maintenance-actions";
import { updateAllPluginsAction } from "@/app/(dashboard)/dashboard/actions";
import { bulkAction } from "@/app/(dashboard)/sites/[id]/bulk-actions";

const VIEWER = {
  id: "u1", email: "u1@example.com", role: "admin",
  permissions: new Set(["sites.view_all", "wp_toolkit.manage", "sites.manage"]),
  grants: new Map(),
};

function fd(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

function site(id: string): SiteRow {
  return { id, status: "connected", url: `https://${id}.example.com`, client_label: null, environment: "production" } as SiteRow;
}

const updateSnapshot = {
  taken_at: "2026-09-29T00:00:00Z",
  payload: {
    plugins: [{ file: "a/a.php", name: "a", version: "1", status: "active", update: "available" }],
    themes: [], core_update: null,
  },
};

beforeEach(() => {
  vi.useRealTimers();
  checkPermissionMock.mockReset();
  checkSiteAccessMock.mockReset();
  createServiceSupabaseMock.mockClear();
  setWindow.mockReset();
  listWindows.mockReset();
  insertActivity.mockReset();
  enqueueBatchMock.mockReset().mockResolvedValue({ batchId: "b1", count: 2 });
  enqueueBulkMock.mockReset().mockResolvedValue({ batchId: "b2", split: { included: [{ id: "a/a.php", label: "a" }], excluded: [] } });
  listSitesForViewerMock.mockReset();
  latestSnapshotMock.mockReset().mockResolvedValue(updateSnapshot);
});

describe("setMaintenanceWindowAction", () => {
  const valid: [string, string][] = [["days", "6"], ["start", "01:00"], ["duration", "120"], ["timezone", "Asia/Manila"]];

  it("is refused without sites.manage and never reaches the database", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    expect(await setMaintenanceWindowAction("s1", null, fd(valid))).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("sites.manage");
    expect(createServiceSupabaseMock).not.toHaveBeenCalled();
  });

  it("is refused without a manage grant on the site", async () => {
    checkPermissionMock.mockResolvedValue(VIEWER);
    checkSiteAccessMock.mockResolvedValue(DENIED);
    expect(await setMaintenanceWindowAction("s1", null, fd(valid))).toEqual(DENIED);
    expect(checkSiteAccessMock).toHaveBeenCalledWith("s1", "manage");
    expect(setWindow).not.toHaveBeenCalled();
  });

  it("rejects an invalid window before writing", async () => {
    checkPermissionMock.mockResolvedValue(VIEWER);
    checkSiteAccessMock.mockResolvedValue(VIEWER);
    const r = await setMaintenanceWindowAction("s1", null, fd([["days", "6"], ["start", "1am"], ["duration", "60"], ["timezone", "Asia/Manila"]]));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/start time/i) });
    expect(setWindow).not.toHaveBeenCalled();
  });

  it("saves a valid window and logs it", async () => {
    checkPermissionMock.mockResolvedValue(VIEWER);
    checkSiteAccessMock.mockResolvedValue(VIEWER);
    expect(await setMaintenanceWindowAction("s1", null, fd(valid))).toEqual({ ok: true });
    expect(setWindow).toHaveBeenCalledWith("s1", SAT_1AM);
    expect(insertActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "site.maintenance_window" }));
  });

  it("clears the window when no day is ticked", async () => {
    checkPermissionMock.mockResolvedValue(VIEWER);
    checkSiteAccessMock.mockResolvedValue(VIEWER);
    expect(await setMaintenanceWindowAction("s1", null, fd([["start", "01:00"], ["duration", "60"], ["timezone", "Asia/Manila"]])))
      .toEqual({ ok: true });
    expect(setWindow).toHaveBeenCalledWith("s1", null);
  });
});

describe("updateAllPluginsAction timing", () => {
  it("runs now by default and never reads windows", async () => {
    checkPermissionMock.mockResolvedValue(VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("a"), site("b")]);
    const r = await updateAllPluginsAction("production", null, fd([]));
    expect(r).toMatchObject({ ok: true });
    expect(listWindows).not.toHaveBeenCalled();
    const opts = enqueueBatchMock.mock.calls[0][4] as { scheduledFor?: Map<string, string> } | undefined;
    expect(opts?.scheduledFor?.size ?? 0).toBe(0);
  });

  it("schedules each site into its own window; sites without one run now", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-30T00:00:00Z"), toFake: ["Date"] });
    checkPermissionMock.mockResolvedValue(VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("a"), site("b")]);
    listWindows.mockResolvedValue(new Map([["a", SAT_1AM], ["b", null]]));

    const r = await updateAllPluginsAction("production", null, fd([["timing", "window"]]));

    expect(listWindows).toHaveBeenCalledWith(["a", "b"]);
    const opts = enqueueBatchMock.mock.calls[0][4] as { scheduledFor: Map<string, string> };
    expect(opts.scheduledFor.get("a")).toBe("2026-10-02T17:00:00.000Z");
    expect(opts.scheduledFor.has("b")).toBe(false);
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/1 will wait for their maintenance window; 1 runs now/) });
  });
});

describe("bulkAction timing", () => {
  it("holds the batch until the site's next window", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-30T00:00:00Z"), toFake: ["Date"] });
    checkPermissionMock.mockResolvedValue(VIEWER);
    checkSiteAccessMock.mockResolvedValue(VIEWER);
    listWindows.mockResolvedValue(new Map([["s1", SAT_1AM]]));

    const r = await bulkAction("s1", "update", "plugin", ["a/a.php"], { timing: "window" });

    expect(r).toMatchObject({ ok: true, scheduledFor: "2026-10-02T17:00:00.000Z" });
    expect(enqueueBulkMock.mock.calls[0][6]).toEqual({ scheduledFor: "2026-10-02T17:00:00.000Z" });
  });

  it("runs now when no timing is given", async () => {
    checkPermissionMock.mockResolvedValue(VIEWER);
    checkSiteAccessMock.mockResolvedValue(VIEWER);
    await bulkAction("s1", "update", "plugin", ["a/a.php"]);
    expect(listWindows).not.toHaveBeenCalled();
    expect(enqueueBulkMock.mock.calls[0][6]).toEqual({});
  });
});
