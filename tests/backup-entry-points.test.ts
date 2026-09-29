import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteRow } from "@/services/sites/types";

// The pre-update backup choice, as each server-action entry point sends it:
//   - bulkAction (Plugins/Themes tab bulk Update) -> enqueueBulk's opts.backup
//   - updateAllPluginsAction (dashboard fleet update) -> enqueueBatch payload
// Default is "back up first": no `backup` field anywhere. Only an explicit
// "Update without a backup" puts backup: "skip" on the jobs.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "u1", email: "u1@example.com" }),
  createServiceSupabase: () => ({}),
}));

const checkPermissionMock = vi.fn();
const checkSiteAccessMock = vi.fn();
vi.mock("@/lib/authz/server", () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
  checkSiteAccess: (...args: unknown[]) => checkSiteAccessMock(...args),
  isDenied: (x: unknown): boolean =>
    typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));

vi.mock("@/services/sites/repo", () => ({
  supabaseSitesRepo: () => ({ insertActivity: () => Promise.resolve() }),
}));
vi.mock("@/lib/mcp/client", () => ({
  createSiteMcpClient: () => { throw new Error("must not connect to MCP from an enqueue-only action"); },
}));
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({ pendingExists: () => Promise.resolve(false) }),
}));
vi.mock("@/services/maintenance/repo", () => ({
  supabaseMaintenanceRepo: () => ({ listWindows: () => Promise.resolve(new Map()) }),
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

import { updateAllPluginsAction } from "@/app/(dashboard)/dashboard/actions";
import { bulkAction } from "@/app/(dashboard)/sites/[id]/bulk-actions";

const VIEWER = {
  id: "u1", email: "u1@example.com", role: "admin",
  permissions: new Set(["sites.view_all", "wp_toolkit.manage"]),
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
  checkPermissionMock.mockReset().mockResolvedValue(VIEWER);
  checkSiteAccessMock.mockReset().mockResolvedValue(VIEWER);
  enqueueBatchMock.mockReset().mockResolvedValue({ batchId: "b1", count: 2 });
  enqueueBulkMock.mockReset().mockResolvedValue({
    batchId: "b2", split: { included: [{ id: "a/a.php", label: "a" }], excluded: [] },
  });
  listSitesForViewerMock.mockReset().mockResolvedValue([site("a"), site("b")]);
  latestSnapshotMock.mockReset().mockResolvedValue(updateSnapshot);
});

describe("updateAllPluginsAction backup choice", () => {
  it("sends only the actor by default -- the gate backs each site up first", async () => {
    const r = await updateAllPluginsAction("production", null, fd([]));
    expect(r).toMatchObject({ ok: true });
    expect(enqueueBatchMock.mock.calls[0][3]).toEqual({ actor: "u1" });
  });

  it("sends backup: skip when the operator ticked Update without a backup", async () => {
    const r = await updateAllPluginsAction("production", null, fd([["backup", "skip"]]));
    expect(enqueueBatchMock.mock.calls[0][3]).toEqual({ actor: "u1", backup: "skip" });
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/without a backup/i) });
  });

  it("ignores any other value", async () => {
    await updateAllPluginsAction("production", null, fd([["backup", "yes please"]]));
    expect(enqueueBatchMock.mock.calls[0][3]).toEqual({ actor: "u1" });
  });
});

describe("bulkAction backup choice", () => {
  it("passes no backup option by default", async () => {
    await bulkAction("s1", "update", "plugin", ["a/a.php"]);
    expect(enqueueBulkMock.mock.calls[0][6]).toEqual({});
  });

  it("passes backup: skip through to enqueueBulk", async () => {
    await bulkAction("s1", "update", "theme", ["a"], { backup: "skip" });
    expect(enqueueBulkMock.mock.calls[0][6]).toEqual({ backup: "skip" });
  });

  it("drops anything but the literal skip", async () => {
    await bulkAction("s1", "update", "plugin", ["a/a.php"], { backup: "nope" as never });
    expect(enqueueBulkMock.mock.calls[0][6]).toEqual({});
  });

  it("never marks non-update kinds, which the gate ignores anyway", async () => {
    await bulkAction("s1", "activate", "plugin", ["a/a.php"], { backup: "skip" });
    expect(enqueueBulkMock.mock.calls[0][6]).toEqual({});
  });
});
