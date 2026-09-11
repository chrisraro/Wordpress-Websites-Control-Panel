import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteRow } from "@/services/sites/types";

// hardenFleetAction (src/app/(dashboard)/dashboard/actions.ts) writes files
// into wp-content on live client websites. Everything below is a property that, if it broke,
// would update plugins on a site nobody asked about:
//   - one environment only, never both
//   - only sites with a *plugin* update waiting (not a theme or core one)
//   - only sites the viewer may manage, never merely read
//   - never twice concurrently on the same site
// It is enqueue-only: a dozen WordPress installs cannot be updated inside one
// request, and the action must never pretend they were.

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

const latestSnapshotMock = vi.fn();
vi.mock("@/services/inventory/repo", () => ({
  supabaseSnapshotsRepo: () => ({ latestSnapshot: (...a: unknown[]) => latestSnapshotMock(...a) }),
}));

const latestChecksMock = vi.fn();
vi.mock("@/services/security/repo", () => ({
  supabaseSecurityRepo: () => ({ latestChecks: (...a: unknown[]) => latestChecksMock(...a) }),
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

import { hardenFleetAction } from "@/app/(dashboard)/dashboard/actions";

const DENIED = { ok: false, error: "You do not have permission to do that." };

function site(
  id: string, status: SiteRow["status"] = "connected", env: "production" | "staging" = "production",
): SiteRow {
  const host = env === "staging" ? `staging.${id}.example.com` : `${id}.example.com`;
  return { id, status, url: `https://${host}`, client_label: null } as SiteRow;
}

/** A latest scan with the given failing hardening checks. */
const scan = (...failing: string[]) => ({
  runAt: "2026-09-11T22:00:00Z",
  checks: [
    ...failing.map((check_id) => ({ check_id, result: "warn" as const })),
    { check_id: "https_urls", result: "pass" as const },
  ],
});

const ADMIN_VIEWER = {
  id: "u1", email: "u1@example.com", role: "admin",
  permissions: new Set(["sites.view_all", "wp_toolkit.manage"]),
  grants: new Map(),
};

beforeEach(() => {
  checkPermissionMock.mockReset();
  listSitesForViewerMock.mockReset();
  enqueueBatchMock.mockReset().mockResolvedValue({ batchId: "b", count: 1 });
  latestChecksMock.mockReset();
  pendingExistsMock.mockReset().mockResolvedValue(false);
});

function must<T>(v: T | null): T { expect(v).not.toBeNull(); return v as T; }
const enqueued = () => (enqueueBatchMock.mock.calls[0]?.[2] as string[]) ?? [];

describe("hardenFleetAction", () => {
  it("is refused without wp_toolkit.manage", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    expect(must(await hardenFleetAction("production"))).toEqual(DENIED);
    expect(enqueueBatchMock).not.toHaveBeenCalled();
  });

  it("touches only the environment it was given", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("prod1"), site("stg1", "connected", "staging")]);
    latestChecksMock.mockResolvedValue(scan("xmlrpc_enabled"));
    await hardenFleetAction("staging");
    expect(enqueued()).toEqual(["stg1"]);
    expect(latestChecksMock).not.toHaveBeenCalledWith("prod1");
  });

  it("queues only sites whose latest scan has a fixable failure", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("clean"), site("unscanned"), site("adminonly"), site("needs")]);
    latestChecksMock.mockImplementation(async (id: string) =>
      id === "clean" ? scan()
        : id === "unscanned" ? null
          // admin_username has no automated fix, so this site has nothing to queue.
          : id === "adminonly" ? scan("admin_username")
            : scan("file_edit_disabled", "security_headers"));
    await hardenFleetAction("production");
    expect(enqueued()).toEqual(["needs"]);
  });

  it("skips disabled sites and sites without a manage grant", async () => {
    checkPermissionMock.mockResolvedValue({
      id: "u2", email: "u2@example.com", role: "client",
      permissions: new Set(["wp_toolkit.manage"]),
      grants: new Map([["s1", "manage"], ["s2", "read"]]),
    });
    listSitesForViewerMock.mockResolvedValue([site("s1"), site("s2"), site("s3", "disabled")]);
    latestChecksMock.mockResolvedValue(scan("xmlrpc_enabled"));
    await hardenFleetAction("production");
    expect(enqueued()).toEqual(["s1"]);
  });

  it("never queues a site that already has hardening pending", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("busy"), site("free")]);
    latestChecksMock.mockResolvedValue(scan("xmlrpc_enabled"));
    pendingExistsMock.mockImplementation(async (_t: string, id: string) => id === "busy");
    const r = must(await hardenFleetAction("production"));
    expect(pendingExistsMock).toHaveBeenCalledWith("harden", "busy");
    expect(enqueued()).toEqual(["free"]);
    expect(r.message).toContain("1 already had a run pending");
  });

  it("queues one batch and hands back its page", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("s1"), site("s2")]);
    latestChecksMock.mockResolvedValue(scan("uploads_listing"));
    enqueueBatchMock.mockResolvedValue({ batchId: "batch-7", count: 2 });
    const r = must(await hardenFleetAction("production"));
    expect(enqueueBatchMock).toHaveBeenCalledWith(expect.anything(), "harden", ["s1", "s2"], { actor: "u1" });
    expect(r.href).toBe("/marketplace/batches/batch-7");
    expect(r.message).toBe("Queued hardening for 2 sites.");
  });
});
