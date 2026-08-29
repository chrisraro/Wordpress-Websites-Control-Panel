import { describe, expect, it } from "vitest";
import { buildThemeInstallPhp } from "@/services/themes/install";

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
