import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow } from "@/services/jobs/types";
import { buildJobHandlers, resolveInstallKind } from "@/services/jobs/handlers";

// The plugin_install handler in src/services/jobs/handlers.ts branches on
// payload.target to decide which installer to run (Plugin_Upgrader vs
// Theme_Upgrader) and which storage bucket an uploaded package's signed URL
// comes from ("plugins" vs "themes"). That branch has real backward-
// compatibility weight: jobs already sitting in the queue have no `target`
// field at all and must keep behaving as plugin installs.
//
// installPlugin/installTheme themselves are already covered by
// tests/install.test.ts and tests/theme-install.test.ts, so here we mock
// both modules and assert the handler routes to the right one with the
// right bucket, rather than re-testing their internals.
const installPluginMock = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, output: "Installed" }));
const installThemeMock = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, output: "Installed" }));
const manageSiteMock = vi.fn(
  (..._args: unknown[]): Promise<{ ok: boolean; output?: string; error?: string }> =>
    Promise.resolve({ ok: true, output: "Done" }),
);

vi.mock("@/services/marketplace/install", () => ({
  installPlugin: (...args: unknown[]) => installPluginMock(...args),
}));
vi.mock("@/services/themes/install", () => ({
  installTheme: (...args: unknown[]) => installThemeMock(...args),
}));
vi.mock("@/services/manage/service", () => ({
  manageSite: (...args: unknown[]) => manageSiteMock(...args),
}));
const refreshVulnFeedMock = vi.fn((..._args: unknown[]) => Promise.resolve({ updated: 0, skipped: true }));
vi.mock("@/services/security/scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/security/scan")>();
  return { ...actual, refreshVulnFeed: (...args: unknown[]) => refreshVulnFeedMock(...args) };
});

function fakeDb(signedUrl = "https://signed.example/pkg.zip") {
  const storageCalls: string[] = [];
  const db = {
    storage: {
      from(bucket: string) {
        storageCalls.push(bucket);
        return {
          async createSignedUrl() {
            return { data: { signedUrl }, error: null };
          },
        };
      },
    },
    // sites/jobs/security/seo/snapshots repos are constructed from `db` but
    // never called: installPlugin/installTheme are mocked above, so nothing
    // inside them ever reaches back into a real Supabase query.
    from() {
      throw new Error("db.from() should not be called when installPlugin/installTheme are mocked");
    },
  } as unknown as SupabaseClient;
  return { db, storageCalls };
}

function jobRow(payload: Record<string, unknown>, overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1", type: "plugin_install", site_id: "site-1", batch_id: null,
    payload, status: "running", attempts: 0,
    scheduled_for: new Date(0).toISOString(), last_error: null, dismissed_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe("resolveInstallKind", () => {
  it("routes target: theme to the theme install path", () => {
    expect(resolveInstallKind("theme")).toEqual({ kind: "theme", bucket: "themes" });
  });
  it("routes target: plugin to the plugin install path", () => {
    expect(resolveInstallKind("plugin")).toEqual({ kind: "plugin", bucket: "plugins" });
  });
  it("defaults a missing target to the plugin install path (back-compat)", () => {
    expect(resolveInstallKind(undefined)).toEqual({ kind: "plugin", bucket: "plugins" });
  });
});

describe("plugin_install handler dispatch", () => {
  beforeEach(() => {
    installPluginMock.mockClear();
    installThemeMock.mockClear();
  });

  it("routes a theme payload to installTheme, not installPlugin", async () => {
    const { db } = fakeDb();
    const handlers = buildJobHandlers(db);
    const job = jobRow({
      source: { kind: "wporg", slug: "storefront" }, activate: true, actor: "user-1", target: "theme",
    });
    await handlers.plugin_install!({ job });
    expect(installThemeMock).toHaveBeenCalledTimes(1);
    expect(installPluginMock).not.toHaveBeenCalled();
    expect(installThemeMock.mock.calls[0]).toMatchObject([
      expect.anything(), "site-1", "user-1", { kind: "wporg", slug: "storefront" }, true,
    ]);
  });

  it("routes a plugin payload to installPlugin, not installTheme", async () => {
    const { db } = fakeDb();
    const handlers = buildJobHandlers(db);
    const job = jobRow({
      source: { kind: "wporg", slug: "akismet" }, activate: false, actor: "user-1", target: "plugin",
    });
    await handlers.plugin_install!({ job });
    expect(installPluginMock).toHaveBeenCalledTimes(1);
    expect(installThemeMock).not.toHaveBeenCalled();
  });

  it("with NO target field at all, still behaves exactly as a plugin install", async () => {
    const { db } = fakeDb();
    const handlers = buildJobHandlers(db);
    // Simulates a job enqueued before the `target` field existed.
    const job = jobRow({ source: { kind: "wporg", slug: "akismet" }, activate: true, actor: "user-1" });
    await handlers.plugin_install!({ job });
    expect(installPluginMock).toHaveBeenCalledTimes(1);
    expect(installThemeMock).not.toHaveBeenCalled();
  });

  it("signs an uploaded theme package from the themes bucket", async () => {
    const { db, storageCalls } = fakeDb("https://signed.example/theme.zip");
    const handlers = buildJobHandlers(db);
    const job = jobRow({
      source: { kind: "upload", path: "uploads/u1/theme.zip" }, activate: false, actor: "user-1", target: "theme",
    });
    await handlers.plugin_install!({ job });
    expect(storageCalls).toEqual(["themes"]);
    expect(installThemeMock).toHaveBeenCalledTimes(1);
    expect(installThemeMock.mock.calls[0][3]).toEqual({ kind: "url", url: "https://signed.example/theme.zip" });
  });

  it("signs an uploaded plugin package from the plugins bucket when target is omitted", async () => {
    const { db, storageCalls } = fakeDb("https://signed.example/plugin.zip");
    const handlers = buildJobHandlers(db);
    const job = jobRow({ source: { kind: "upload", path: "uploads/u1/plugin.zip" }, activate: false, actor: "user-1" });
    await handlers.plugin_install!({ job });
    expect(storageCalls).toEqual(["plugins"]);
    expect(installPluginMock).toHaveBeenCalledTimes(1);
    expect(installPluginMock.mock.calls[0][3]).toEqual({ kind: "url", url: "https://signed.example/plugin.zip" });
  });
});

// The freshness guard in refreshVulnFeed must be bypassed on a retry (see
// src/services/security/scan.ts's `allowSkip` doc comment and the "partial
// write" scenario it defends against) — this pins that the handler actually
// derives `allowSkip` from `job.attempts` and doesn't hard-code it either way.
describe("vuln_feed_refresh handler dispatch", () => {
  beforeEach(() => {
    refreshVulnFeedMock.mockClear();
  });

  it("allows the freshness guard to skip on a job's first attempt", async () => {
    const { db } = fakeDb();
    const handlers = buildJobHandlers(db);
    const job = jobRow({}, { type: "vuln_feed_refresh", site_id: null, attempts: 1 });
    await handlers.vuln_feed_refresh!({ job });
    expect(refreshVulnFeedMock).toHaveBeenCalledTimes(1);
    expect(refreshVulnFeedMock.mock.calls[0][2]).toEqual({ allowSkip: true });
  });

  it("forbids the freshness guard from skipping on a retry", async () => {
    const { db } = fakeDb();
    const handlers = buildJobHandlers(db);
    const job = jobRow({}, { type: "vuln_feed_refresh", site_id: null, attempts: 2 });
    await handlers.vuln_feed_refresh!({ job });
    expect(refreshVulnFeedMock).toHaveBeenCalledTimes(1);
    expect(refreshVulnFeedMock.mock.calls[0][2]).toEqual({ allowSkip: false });
  });
});

// bulk_manage turns one queued item from a bulk update/activate/deactivate/
// delete selection into a manageSite() call. It was previously untested:
// none of the guards below, nor the throw-on-!result.ok contract the whole
// retry ladder depends on (a thrown error is what puts the job back on the
// retry ladder in services/jobs/service.ts; a failing item must never abort
// its batch siblings, which are separate jobs).
describe("bulk_manage handler", () => {
  beforeEach(() => {
    manageSiteMock.mockClear();
  });

  it("throws on a malformed payload (missing kind/target/id/actor)", async () => {
    const { db } = fakeDb();
    const handlers = buildJobHandlers(db);
    const job = jobRow({ kind: "delete", target: "plugin" }, { type: "bulk_manage" }); // no id, no actor
    await expect(handlers.bulk_manage!({ job })).rejects.toThrow("bulk_manage payload malformed");
    expect(manageSiteMock).not.toHaveBeenCalled();
  });

  it("throws when the job has no site_id", async () => {
    const { db } = fakeDb();
    const handlers = buildJobHandlers(db);
    const job = jobRow(
      { kind: "delete", target: "plugin", id: "akismet/akismet.php", actor: "user-1" },
      { type: "bulk_manage", site_id: null },
    );
    await expect(handlers.bulk_manage!({ job })).rejects.toThrow("bulk_manage requires a site_id");
    expect(manageSiteMock).not.toHaveBeenCalled();
  });

  it("propagates toManageAction's throw for an invalid kind/target combination", async () => {
    const { db } = fakeDb();
    const handlers = buildJobHandlers(db);
    // Themes are switched, never deactivated — toManageAction rejects this
    // combination before manageSite is ever reached.
    const job = jobRow(
      { kind: "deactivate", target: "theme", id: "storefront", actor: "user-1" },
      { type: "bulk_manage" },
    );
    await expect(handlers.bulk_manage!({ job })).rejects.toThrow("Themes cannot be deactivated");
    expect(manageSiteMock).not.toHaveBeenCalled();
  });

  it("throws with the underlying error when manageSite reports !ok, so the job retries", async () => {
    const { db } = fakeDb();
    manageSiteMock.mockResolvedValueOnce({ ok: false, error: "Deactivate the plugin before deleting it" });
    const handlers = buildJobHandlers(db);
    const job = jobRow(
      { kind: "delete", target: "plugin", id: "akismet/akismet.php", actor: "user-1" },
      { type: "bulk_manage" },
    );
    await expect(handlers.bulk_manage!({ job })).rejects.toThrow("Deactivate the plugin before deleting it");
  });

  it("treats a retried plugin delete that reports 'Plugin is not installed' as idempotent success", async () => {
    const { db } = fakeDb();
    manageSiteMock.mockResolvedValueOnce({ ok: false, error: "Plugin is not installed" });
    const handlers = buildJobHandlers(db);
    const job = jobRow(
      { kind: "delete", target: "plugin", id: "akismet/akismet.php", actor: "user-1" },
      { type: "bulk_manage" },
    );
    await expect(handlers.bulk_manage!({ job })).resolves.toBeUndefined();
  });

  it("treats a retried theme delete that reports 'Theme is not installed' as idempotent success", async () => {
    const { db } = fakeDb();
    manageSiteMock.mockResolvedValueOnce({ ok: false, error: "Theme is not installed" });
    const handlers = buildJobHandlers(db);
    const job = jobRow(
      { kind: "delete", target: "theme", id: "storefront", actor: "user-1" },
      { type: "bulk_manage" },
    );
    await expect(handlers.bulk_manage!({ job })).resolves.toBeUndefined();
  });

  it("still fails a non-delete kind that reports 'not installed' (genuine failure, not a retry)", async () => {
    const { db } = fakeDb();
    manageSiteMock.mockResolvedValueOnce({ ok: false, error: "Plugin is not installed" });
    const handlers = buildJobHandlers(db);
    const job = jobRow(
      { kind: "update", target: "plugin", id: "akismet/akismet.php", actor: "user-1" },
      { type: "bulk_manage" },
    );
    await expect(handlers.bulk_manage!({ job })).rejects.toThrow("Plugin is not installed");
  });

  it("does not treat a mismatched target's 'not installed' text as idempotent (theme id, plugin error text)", async () => {
    const { db } = fakeDb();
    manageSiteMock.mockResolvedValueOnce({ ok: false, error: "Plugin is not installed" });
    const handlers = buildJobHandlers(db);
    const job = jobRow(
      { kind: "delete", target: "theme", id: "storefront", actor: "user-1" },
      { type: "bulk_manage" },
    );
    await expect(handlers.bulk_manage!({ job })).rejects.toThrow("Plugin is not installed");
  });

  it("routes a successful plugin delete to the delete_plugin ManageAction", async () => {
    const { db } = fakeDb();
    manageSiteMock.mockResolvedValueOnce({ ok: true, output: "Plugin deleted" });
    const handlers = buildJobHandlers(db);
    const job = jobRow(
      { kind: "delete", target: "plugin", id: "akismet/akismet.php", label: "Akismet", actor: "user-1" },
      { type: "bulk_manage", site_id: "site-1" },
    );
    await expect(handlers.bulk_manage!({ job })).resolves.toBeUndefined();
    expect(manageSiteMock).toHaveBeenCalledTimes(1);
    expect(manageSiteMock.mock.calls[0]).toMatchObject([
      expect.anything(), "site-1", "user-1", { kind: "delete_plugin", file: "akismet/akismet.php" },
    ]);
  });
});
