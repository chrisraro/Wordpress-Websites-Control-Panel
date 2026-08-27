import { describe, it, expect } from "vitest";
import { HARDENING_PHP, runPhpHardening, runHttpHardening } from "@/services/security/hardening";
import { MockMcpClient } from "@/lib/mcp/mock";

describe("HARDENING_PHP", () => {
  it("covers the 11 PHP-side checks and returns JSON", () => {
    for (const id of [
      "wp_debug", "debug_display", "file_edit_disabled", "https_urls", "default_table_prefix",
      "admin_username", "default_salts", "user_registration", "php_version", "inactive_plugins",
      "wp_config_permissions",
    ]) {
      expect(HARDENING_PHP).toContain(`'${id}'`);
    }
    expect(HARDENING_PHP).toContain("return json_encode");
  });
});

describe("runPhpHardening", () => {
  it("returns the parsed checks", async () => {
    const checks = [{ check_id: "wp_debug", result: "pass" }];
    const mock = new MockMcpClient({
      handler: (name) => {
        expect(name).toBe("novamira/execute-php");
        return { success: true, data: { success: true, return_value: JSON.stringify(checks) } };
      },
    });
    expect(await runPhpHardening(mock)).toEqual(checks);
  });
});

function fetchStub(routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }>) {
  return (async (url: unknown) => {
    const u = String(url);
    const hit = Object.entries(routes).find(([suffix]) => u.endsWith(suffix) || (suffix === "/" && u.endsWith(".test/")));
    const r = hit?.[1] ?? { status: 404 };
    return new Response(r.body ?? "", { status: r.status, headers: r.headers });
  }) as typeof fetch;
}

describe("runHttpHardening", () => {
  it("flags reachable xmlrpc, open uploads listing, and missing headers", async () => {
    const checks = await runHttpHardening("https://site.test", fetchStub({
      "/xmlrpc.php": { status: 405 },
      "/wp-content/uploads/": { status: 200, body: "<title>Index of /wp-content/uploads</title>" },
      "/": { status: 200, headers: {} },
    }));
    const byId = Object.fromEntries(checks.map((c) => [c.check_id, c.result]));
    expect(byId.xmlrpc_enabled).toBe("warn");
    expect(byId.uploads_listing).toBe("fail");
    expect(byId.security_headers).toBe("warn");
  });

  it("passes when xmlrpc blocked, listing off, headers present", async () => {
    const checks = await runHttpHardening("https://site.test", fetchStub({
      "/xmlrpc.php": { status: 403 },
      "/wp-content/uploads/": { status: 403 },
      "/": { status: 200, headers: { "x-frame-options": "SAMEORIGIN" } },
    }));
    const byId = Object.fromEntries(checks.map((c) => [c.check_id, c.result]));
    expect(byId.xmlrpc_enabled).toBe("pass");
    expect(byId.uploads_listing).toBe("pass");
    expect(byId.security_headers).toBe("pass");
  });

  it("treats network failures as warn, not crash", async () => {
    const failing = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    const checks = await runHttpHardening("https://down.test", failing);
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.result === "warn")).toBe(true);
  });
});
