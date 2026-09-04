import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteRow } from "@/services/sites/types";

// updateAllPluginsAction (src/app/(dashboard)/dashboard/actions.ts) writes to
// live client websites. Everything below is a property that, if it broke,
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

const listSitesForViewerMock = vi.fn();
vi.mock("@/services/sites/service", () => ({
  listSitesForViewer: (...args: unknown[]) => listSitesForViewerMock(...args),
}));

const enqueueBatchMock = vi.fn();
vi.mock("@/services/jobs/service", () => ({
  enqueueJob: vi.fn(),
  enqueueBatch: (...args: unknown[]) => enqueueBatchMock(...args),
}));

import { updateAllPluginsAction } from "@/app/(dashboard)/dashboard/actions";

const DENIED = { ok: false, error: "You do not have permission to do that." };

function site(
  id: string, status: SiteRow["status"] = "connected", env: "production" | "staging" = "production",
): SiteRow {
  const host = env === "staging" ? `staging.${id}.example.com` : `${id}.example.com`;
  return { id, status, url: `https://${host}`, client_label: null } as SiteRow;
}

/** A snapshot with `plugins` plugin updates, `themes` theme updates, and core. */
function snapshot(plugins: number, themes = 0, core = false) {
  return {
    taken_at: "2026-09-04T00:00:00Z",
    payload: {
      plugins: Array.from({ length: plugins }, (_, i) => ({ file: `p${i}`, update: "available" })),
      themes: Array.from({ length: themes }, (_, i) => ({ slug: `t${i}`, update: "available" })),
      core_update: core,
    },
  };
}

const ADMIN_VIEWER = {
  id: "u1", email: "u1@example.com", role: "admin",
  permissions: new Set(["sites.view_all", "wp_toolkit.manage"]),
  grants: new Map(),
};

beforeEach(() => {
  checkPermissionMock.mockReset();
  listSitesForViewerMock.mockReset();
  enqueueBatchMock.mockReset();
  latestSnapshotMock.mockReset();
  pendingExistsMock.mockReset().mockResolvedValue(false);
  enqueueBatchMock.mockResolvedValue({ batchId: "batch-1", count: 0 });
});

/** ManageResult is nullable by contract; this action never returns null, and
 *  saying so once beats an assertion on every field access. */
function must<T>(v: T | null): T {
  expect(v).not.toBeNull();
  return v as T;
}

/** The site ids handed to enqueueBatch, which is what actually gets updated. */
const enqueued = () => (enqueueBatchMock.mock.calls[0]?.[2] as string[]) ?? [];

describe("updateAllPluginsAction", () => {
  it("is refused without wp_toolkit.manage, and never lists or enqueues anything", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = must(await updateAllPluginsAction("production"));
    expect(result).toEqual(DENIED);
    expect(listSitesForViewerMock).not.toHaveBeenCalled();
    expect(enqueueBatchMock).not.toHaveBeenCalled();
  });

  it("touches only the environment it was given", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([
      site("prod1", "connected", "production"),
      site("stg1", "connected", "staging"),
    ]);
    latestSnapshotMock.mockResolvedValue(snapshot(3));
    enqueueBatchMock.mockResolvedValue({ batchId: "b", count: 1 });

    await updateAllPluginsAction("staging");
    expect(enqueued()).toEqual(["stg1"]);
    // The production site was never even asked for a snapshot.
    expect(latestSnapshotMock).not.toHaveBeenCalledWith("prod1");
  });

  it("skips a site whose only pending update is a theme or core", async () => {
    // The button says "update plugins". A site with a theme update and no
    // plugin update has nothing for this action to do, and queueing it would
    // promise work that cannot happen.
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("themeonly"), site("coreonly"), site("real")]);
    latestSnapshotMock.mockImplementation(async (id: string) =>
      id === "themeonly" ? snapshot(0, 4)
        : id === "coreonly" ? snapshot(0, 0, true)
          : snapshot(2));
    enqueueBatchMock.mockResolvedValue({ batchId: "b", count: 1 });

    await updateAllPluginsAction("production");
    expect(enqueued()).toEqual(["real"]);
  });

  it("skips disabled sites and sites without a manage grant", async () => {
    const viewer = {
      id: "u2", email: "u2@example.com", role: "client",
      permissions: new Set(["wp_toolkit.manage"]),
      grants: new Map([["s1", "manage"], ["s2", "read"]]),
    };
    checkPermissionMock.mockResolvedValue(viewer);
    listSitesForViewerMock.mockResolvedValue([
      site("s1"), site("s2"), site("s3"), site("s4", "disabled"),
    ]);
    latestSnapshotMock.mockResolvedValue(snapshot(1));
    enqueueBatchMock.mockResolvedValue({ batchId: "b", count: 1 });

    await updateAllPluginsAction("production");
    expect(enqueued()).toEqual(["s1"]);
  });

  it("never queues a second run for a site that already has one pending", async () => {
    // Two concurrent update passes on one WordPress install is how a plugin
    // directory gets corrupted.
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("busy"), site("free")]);
    latestSnapshotMock.mockResolvedValue(snapshot(2));
    pendingExistsMock.mockImplementation(async (_t: string, id: string) => id === "busy");
    enqueueBatchMock.mockResolvedValue({ batchId: "b", count: 1 });

    const result = must(await updateAllPluginsAction("production"));

    expect(pendingExistsMock).toHaveBeenCalledWith("update_all_plugins", "busy");
    expect(enqueued()).toEqual(["free"]);
    expect(result.message).toContain("1 already had a run pending");
  });

  it("refuses without enqueuing when nothing in the tab has a plugin update", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("s1")]);
    latestSnapshotMock.mockResolvedValue(snapshot(0));

    const result = must(await updateAllPluginsAction("staging"));

    expect(result.ok).toBe(false);
    expect(result.error).toBe("No staging site has a plugin update waiting.");
    expect(enqueueBatchMock).not.toHaveBeenCalled();
  });

  it("refuses without enqueuing when a site has never been inventoried", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("s1")]);
    latestSnapshotMock.mockResolvedValue(null);

    const result = must(await updateAllPluginsAction("production"));
    expect(result.ok).toBe(false);
    expect(enqueueBatchMock).not.toHaveBeenCalled();
  });

  it("queues one batch and hands back the page that shows it", async () => {
    checkPermissionMock.mockResolvedValue(ADMIN_VIEWER);
    listSitesForViewerMock.mockResolvedValue([site("s1"), site("s2")]);
    latestSnapshotMock.mockResolvedValue(snapshot(3));
    enqueueBatchMock.mockResolvedValue({ batchId: "batch-9", count: 2 });

    const result = must(await updateAllPluginsAction("production"));

    expect(enqueueBatchMock).toHaveBeenCalledTimes(1);
    expect(enqueueBatchMock).toHaveBeenCalledWith(
      expect.anything(), "update_all_plugins", ["s1", "s2"], { actor: "u1" },
    );
    expect(result.ok).toBe(true);
    expect(result.href).toBe("/marketplace/batches/batch-9");
    // "Queued", never "updated": nothing has run yet.
    expect(result.message).toBe("Queued plugin updates for 2 sites.");
    expect(result.message).not.toMatch(/\bupdated\b/);
  });
});
