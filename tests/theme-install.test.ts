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

  it("rejects a non-https upload URL", () => {
    expect(() => buildThemeInstallPhp({ kind: "url", url: "http://x/t.zip" }, false)).toThrow();
  });

  it("rejects a malformed slug", () => {
    expect(() => buildThemeInstallPhp({ kind: "wporg", slug: "../evil" }, false)).toThrow();
  });
});
