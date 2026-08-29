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

vi.mock("@/services/marketplace/install", () => ({
  installPlugin: (...args: unknown[]) => installPluginMock(...args),
}));
vi.mock("@/services/themes/install", () => ({
  installTheme: (...args: unknown[]) => installThemeMock(...args),
}));

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

function jobRow(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1", type: "plugin_install", site_id: "site-1", batch_id: null,
    payload, status: "running", attempts: 0,
    scheduled_for: new Date(0).toISOString(), last_error: null,
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
