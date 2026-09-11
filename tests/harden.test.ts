import { describe, it, expect } from "vitest";
import {
  hardeningPlan, buildHardenPhp, HARDENING_FIXES, FIX_LABEL, isHardeningFix,
} from "@/services/security/harden";

const c = (check_id: string, result: "pass" | "warn" | "fail") => ({ check_id, result });

describe("hardeningPlan", () => {
  it("proposes a fix for every failing check that has one", () => {
    const plan = hardeningPlan([
      c("xmlrpc_enabled", "warn"), c("file_edit_disabled", "warn"), c("security_headers", "warn"),
      c("uploads_listing", "fail"), c("wp_config_permissions", "warn"),
    ]);
    expect(plan.sort()).toEqual([...HARDENING_FIXES].sort());
  });

  it("proposes nothing for a passing check", () => {
    expect(hardeningPlan([c("xmlrpc_enabled", "pass"), c("uploads_listing", "pass")])).toEqual([]);
  });

  it("never proposes the two checks that need a human", () => {
    // Renaming an administrator and deleting plugins are choices, not fixes.
    const plan = hardeningPlan([c("admin_username", "fail"), c("inactive_plugins", "warn")]);
    expect(plan).toEqual([]);
  });

  it("ignores checks it has no fix for", () => {
    expect(hardeningPlan([c("wp_debug", "fail"), c("default_salts", "fail")])).toEqual([]);
  });

  it("de-duplicates", () => {
    expect(hardeningPlan([c("xmlrpc_enabled", "warn"), c("xmlrpc_enabled", "warn")])).toEqual(["xmlrpc"]);
  });
});

describe("buildHardenPhp", () => {
  it("contains no backslashes at all", () => {
    // Every file body travels base64'd, so the PHP never needs an escape --
    // and an escape here is exactly what a JS template literal would eat.
    for (const mode of ["harden", "unharden"] as const) {
      expect(buildHardenPhp([...HARDENING_FIXES], mode)).not.toContain(String.fromCharCode(92));
    }
  });

  it("rejects an unknown fix before any PHP is built", () => {
    expect(() => buildHardenPhp(["rm_rf" as never], "harden")).toThrow(/Unknown hardening fix/);
    expect(isHardeningFix("rm_rf")).toBe(false);
  });

  it("writes through a temp file and rename, never directly", () => {
    // A half-written mu-plugin is a fatal error on every page load.
    const php = buildHardenPhp(["xmlrpc"], "harden");
    expect(php).toContain(".tmp-");
    expect(php).toContain("rename($tmp, $path)");
    expect(php).not.toMatch(/file_put_contents\(\$path/);
  });

  it("refuses to overwrite or delete a file it did not write", () => {
    const php = buildHardenPhp(["headers"], "unharden");
    expect(php).toContain("was not written by the panel");
    expect(buildHardenPhp(["headers"], "harden")).toContain("exists and was not written by the panel");
  });

  it("never reverts permissions on unharden", () => {
    const php = buildHardenPhp(["wp_config_perms"], "unharden");
    expect(php).not.toContain("chmod");
  });
});

describe("the files each fix writes", () => {
  // Decode what the PHP would write and check it does what its check reads.
  const bodies = (fix: (typeof HARDENING_FIXES)[number]) => {
    const php = buildHardenPhp([fix], "harden");
    return [...php.matchAll(/base64_decode\('([A-Za-z0-9+/=]+)'\)/g)]
      .map((m) => Buffer.from(m[1], "base64").toString("utf8"));
  };

  it("xmlrpc: answers 403 for the request the scanner makes, not just the POST filter", () => {
    // The scanner GETs xmlrpc.php and treats 405 as enabled. WordPress's own
    // xmlrpc_enabled filter still answers 405 to a GET.
    const body = bodies("xmlrpc").find((b) => b.includes("XMLRPC_REQUEST"))!;
    expect(body).toContain("status_header(403)");
    expect(body).toContain("add_filter('xmlrpc_enabled', '__return_false')");
  });

  it("file_edit: defines the constant the scanner reads, guarded", () => {
    const body = bodies("file_edit").find((b) => b.includes("DISALLOW_FILE_EDIT"))!;
    expect(body).toContain("if (!defined('DISALLOW_FILE_EDIT'))");
    expect(body).toContain("define('DISALLOW_FILE_EDIT', true)");
  });

  it("headers: sends the header the scanner looks for", () => {
    const body = bodies("headers").find((b) => b.includes("send_headers"))!;
    expect(body).toContain("X-Frame-Options: SAMEORIGIN");
    expect(body).toContain("headers_sent()");
  });

  it("uploads_index: is WordPress's own silence file", () => {
    expect(bodies("uploads_index")).toContainEqual(expect.stringContaining("Silence is golden"));
  });

  it("every mu-plugin carries the marker unharden checks for, and a valid header", () => {
    for (const fix of ["xmlrpc", "file_edit", "headers"] as const) {
      const body = bodies(fix).find((b) => b.startsWith("<?php"))!;
      expect(body).toContain("Plugin Name: OCS Hardening");
      expect(body).toContain("Written by WP Control Panel");
    }
  });

  it("has a plain-language label for every fix", () => {
    for (const f of HARDENING_FIXES) expect(FIX_LABEL[f].length).toBeGreaterThan(20);
  });
});
