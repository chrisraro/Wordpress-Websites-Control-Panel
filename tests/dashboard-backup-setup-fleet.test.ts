import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteRow } from "@/services/sites/types";

// setupBackupsFleetAction installs and configures UpdraftPlus on client
// sites. Enqueue-only, one environment, manage grant required, never twice
// concurrently on a site.

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
vi.mock("@/lib/mcp/client", () => ({
  createSiteMcpClient: () => { throw new Error("must not connect to MCP from an enqueue-only action"); },
}));
const pendingExistsMock = vi.fn();
vi.mock("@/services/jobs/repo", () => ({
  supabaseJobsRepo: () => ({ pendingExists: (...a: unknown[]) => pendingExistsMock(...a) }),
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
vi.mock("@/services/manage/held-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/manage/held-jobs")>()),
  supabaseHeldJobsDeps: () => ({ liveJob: async () => null, getWindow: async () => null }),
}));

import { setupBackupsFleetAction } from "@/app/(dashboard)/dashboard/actions";

function site(id: string, status: SiteRow["status"] = "connected", env: "production" | "staging" = "production"): SiteRow {
  return { id, status, environment: env, url: `https://${id}.example.com`, client_label: null } as SiteRow;
}
// No sites.view_all, so the per-site manage grant decides ("x" has none).
const viewer = (grants: string[]) => ({
  id: "u1", email: "u1@example.com", role: "operator",
  permissions: new Set(["wp_toolkit.manage"]),
  grants: new Map(grants.map((g) => [g, "manage"])),
});

beforeEach(() => {
  vi.clearAllMocks();
  pendingExistsMock.mockResolvedValue(false);
  enqueueBatchMock.mockImplementation(async (_r: unknown, _t: unknown, ids: string[]) => ({ batchId: "b1", count: ids.length }));
});

describe("setupBackupsFleetAction", () => {
  it("is refused without wp_toolkit.manage", async () => {
    checkPermissionMock.mockResolvedValue({ ok: false, error: "no" });
    expect((await setupBackupsFleetAction("production"))?.ok).toBe(false);
    expect(enqueueBatchMock).not.toHaveBeenCalled();
  });

  it("queues one backup_setup job per manageable, enabled site in the environment", async () => {
    checkPermissionMock.mockResolvedValue(viewer(["a", "b", "c", "d"]));
    listSitesForViewerMock.mockResolvedValue([
      site("a"), site("b", "disabled"), site("c", "connected", "staging"), site("d"), site("x"),
    ]);
    const r = await setupBackupsFleetAction("production");
    expect(r?.ok).toBe(true);
    expect(enqueueBatchMock).toHaveBeenCalledWith(expect.anything(), "backup_setup", ["a", "d"], { actor: "u1" });
    expect((r as { message: string }).message).toMatch(/Sign in with Google/);
  });

  it("skips a site that already has a setup run pending", async () => {
    checkPermissionMock.mockResolvedValue(viewer(["a", "d"]));
    listSitesForViewerMock.mockResolvedValue([site("a"), site("d")]);
    pendingExistsMock.mockImplementation(async (_t: string, id: string) => id === "a");
    await setupBackupsFleetAction("production");
    expect(enqueueBatchMock).toHaveBeenCalledWith(expect.anything(), "backup_setup", ["d"], { actor: "u1" });
  });
});
