import { describe, expect, it, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { buildThemeInstallPhp, installTheme } from "@/services/themes/install";
import type { ThemeInstallDeps } from "@/services/themes/install";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("buildThemeInstallPhp", () => {
  it("short-circuits when the theme is already installed", () => {
    // Theme_Upgrader::install() fails deterministically with folder_exists,
    // so retrying three times wastes six minutes to reach the same answer.
    const php = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, false);
    expect(php).toContain("wp_get_theme");
    expect(php).toContain("exists()");
  });

  it("resolves the download link through themes_api", () => {
    const php = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, false);
    expect(php).toContain("wp-admin/includes/theme-install.php");
    expect(php).toContain("themes_api");
  });

  it("passes the slug as base64", () => {
    const php = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, false);
    expect(php).not.toMatch(/'storefront'/);
    expect(php).toContain(Buffer.from("storefront", "utf8").toString("base64"));
  });

  it("overwrites only for uploads, never for wp.org installs", () => {
    const upload = buildThemeInstallPhp({ kind: "url", url: "https://x/t.zip" }, false);
    expect(upload).toContain("overwrite_package");
    const wporg = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, false);
    expect(wporg).not.toContain("overwrite_package");
  });

  it("activates through switch_theme when asked", () => {
    const php = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, true);
    expect(php).toContain("switch_theme");
  });

  it("surfaces the real upgrader failure reason instead of a generic message", () => {
    // Theme_Upgrader::install() returning false means the skin captured the
    // actual reason (bad permissions, expired URL, corrupt zip); read it
    // back through get_upgrade_messages() instead of guessing.
    const php = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, false);
    expect(php).toContain("get_upgrade_messages");
  });

  it("does not re-switch when the theme to activate is already active", () => {
    // switch_theme() fires switch_theme/after_switch_theme hooks, which some
    // themes use for first-run setup; re-activating the current theme should
    // not re-run that work.
    const alreadyInstalled = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, true);
    expect(alreadyInstalled).toContain("get_stylesheet() === $slug");

    const freshInstall = buildThemeInstallPhp({ kind: "url", url: "https://x/t.zip" }, true);
    expect(freshInstall).toContain("get_stylesheet() === $stylesheet");
  });

  it("rejects a non-https upload URL", () => {
    expect(() => buildThemeInstallPhp({ kind: "url", url: "http://x/t.zip" }, false)).toThrow();
  });

  it("rejects a malformed slug", () => {
    expect(() => buildThemeInstallPhp({ kind: "wporg", slug: "../evil" }, false)).toThrow();
  });
});

function phpResult(payload: unknown) {
  return { success: true, data: { success: true, return_value: JSON.stringify(payload), output: "", errors: [] } };
}

function fakeDeps(mock: MockMcpClient) {
  const activity: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let creds = "";
  const sites = {
    async getSiteCredentials(id: string) {
      return id === "site-1"
        ? { mcp_endpoint: "https://x/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: creds }
        : null;
    },
    async insertActivity(e: Record<string, unknown>) { activity.push(e); },
  } as unknown as SitesRepo;
  const jobs = {
    async pendingExists() { return false; },
    async insert(j: Record<string, unknown>) { enqueued.push(j); return { id: "j1" }; },
  } as unknown as JobsRepo;
  const deps: ThemeInstallDeps = { sites, jobs, mcp: async () => mock };
  return { deps, activity, enqueued, setCreds: (v: string) => { creds = v; } };
}

describe("installTheme", () => {
  it("installs, logs activity, enqueues snapshot refresh", async () => {
    const mock = new MockMcpClient({
      handler: (name, args) => {
        expect(name).toBe("novamira/execute-php");
        expect((args as { code: string }).code).toContain("Theme_Upgrader");
        return phpResult({ ok: true, message: "Installed and activated", slug: "storefront" });
      },
    });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await installTheme(f.deps, "site-1", "user-1", { kind: "wporg", slug: "storefront" }, true);
    expect(res).toMatchObject({ ok: true, output: "Installed and activated" });
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ actor: "user-1", site_id: "site-1", action: "site.theme_install" });
    expect(f.enqueued[0]).toMatchObject({ type: "snapshot_refresh" });
  });

  it("surfaces failure without enqueueing refresh", async () => {
    const mock = new MockMcpClient({ handler: () => phpResult({ ok: false, error: "Download failed." }) });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await installTheme(f.deps, "site-1", "user-1", { kind: "wporg", slug: "ghost" }, false);
    expect(res).toMatchObject({ ok: false, error: "Download failed." });
    expect(f.enqueued).toHaveLength(0);
    expect(f.activity[0]).toMatchObject({ action: "site.theme_install" });
  });

  it("logs rejected invalid sources without opening a client", async () => {
    const mock = new MockMcpClient();
    const f = fakeDeps(mock);
    const res = await installTheme(f.deps, "site-1", "user-1", { kind: "wporg", slug: "../evil" }, false);
    expect(res.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
    expect(f.activity[0]).toMatchObject({ action: "site.theme_install" });
  });

  it("reports the site as not found when credentials are missing", async () => {
    const mock = new MockMcpClient();
    const f = fakeDeps(mock);
    const res = await installTheme(f.deps, "missing-site", "user-1", { kind: "wporg", slug: "storefront" }, false);
    expect(res).toEqual({ ok: false, error: "Site not found" });
    expect(mock.calls).toHaveLength(0);
  });
});
