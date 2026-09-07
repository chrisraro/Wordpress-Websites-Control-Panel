import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { buildPhp, manageSite, PLUGIN_FILE_RE, SLUG_RE } from "@/services/manage/service";
import type { ManageDeps } from "@/services/manage/service";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("validation patterns", () => {
  it("accepts normal plugin files and theme slugs", () => {
    for (const f of ["akismet/akismet.php", "hello.php", "woo-checkout/checkout-form-designer.php"]) {
      expect(PLUGIN_FILE_RE.test(f)).toBe(true);
    }
    for (const s of ["generatepress", "twentytwentyfive", "gp-child_2"]) {
      expect(SLUG_RE.test(s)).toBe(true);
    }
  });
  it("rejects injection-shaped values", () => {
    for (const f of ["--allow-root", "-x.php", "a b.php", "../evil.php", "a;b.php", "akismet", "a'.php", "a/b/c.php"]) {
      expect(PLUGIN_FILE_RE.test(f)).toBe(false);
    }
    for (const s of ["--flag", "a b", "a'b", ""]) {
      expect(SLUG_RE.test(s)).toBe(false);
    }
  });
});

describe("buildPhp", () => {
  it("embeds untrusted values only as base64", () => {
    const code = buildPhp({ kind: "update_plugin", file: "akismet/akismet.php" });
    expect(code).toContain(`base64_decode('${b64("akismet/akismet.php")}')`);
    expect(code).not.toContain("akismet/akismet.php'");
    expect(code).toContain("Plugin_Upgrader");
    expect(code).toContain("return json_encode");
  });

  it("generates the right WordPress calls per action", () => {
    expect(buildPhp({ kind: "activate_plugin", file: "hello.php" })).toContain("activate_plugin(");
    expect(buildPhp({ kind: "deactivate_plugin", file: "hello.php" })).toContain("deactivate_plugins(");
    expect(buildPhp({ kind: "update_all_plugins" })).toContain("bulk_upgrade($files)");
    expect(buildPhp({ kind: "update_theme", slug: "generatepress" })).toContain("Theme_Upgrader");
    expect(buildPhp({ kind: "update_core" })).toContain("Core_Upgrader");
    expect(buildPhp({ kind: "maintenance", enable: true })).toContain(".maintenance");
    expect(buildPhp({ kind: "maintenance", enable: false })).toContain("unlink");
    expect(buildPhp({ kind: "flush_cache" })).toContain("wp_cache_flush()");
    expect(buildPhp({ kind: "flush_permalinks" })).toContain("flush_rewrite_rules(true)");
  });

  it("throws on invalid plugin files and slugs", () => {
    expect(() => buildPhp({ kind: "update_plugin", file: "--allow-root" })).toThrow(/invalid plugin file/i);
    expect(() => buildPhp({ kind: "activate_plugin", file: "a;b.php" })).toThrow(/invalid plugin file/i);
    expect(() => buildPhp({ kind: "update_theme", slug: "a b" })).toThrow(/invalid slug/i);
  });
});

describe("buildPhp — delete_plugin", () => {
  it("refuses to delete an active plugin, inside WordPress", () => {
    const php = buildPhp({ kind: "delete_plugin", file: "akismet/akismet.php" });
    expect(php).toContain("is_plugin_active");
    expect(php).toContain("delete_plugins");
  });

  it("passes the plugin file as base64, never interpolated", () => {
    const php = buildPhp({ kind: "delete_plugin", file: "akismet/akismet.php" });
    expect(php).not.toContain("akismet/akismet.php");
    expect(php).toContain(Buffer.from("akismet/akismet.php", "utf8").toString("base64"));
  });

  it("rejects a malformed plugin file", () => {
    expect(() => buildPhp({ kind: "delete_plugin", file: "../../evil.php" })).toThrow();
  });

  it("checks WP_Filesystem()'s return value instead of calling it bare", () => {
    const php = buildPhp({ kind: "delete_plugin", file: "akismet/akismet.php" });
    expect(php).not.toContain("WP_Filesystem();");
    expect(php).toContain("if (!WP_Filesystem())");
  });
});

describe("buildPhp — activate_theme", () => {
  it("checks the theme and its parent exist before switching", () => {
    const php = buildPhp({ kind: "activate_theme", slug: "storefront" });
    expect(php).toContain("wp_get_theme");
    expect(php).toContain("switch_theme");
    expect(php).toContain("get_stylesheet()");
  });

  it("passes the slug as base64, never interpolated", () => {
    const php = buildPhp({ kind: "activate_theme", slug: "storefront" });
    expect(php).not.toContain("'storefront'");
    expect(php).toContain(Buffer.from("storefront", "utf8").toString("base64"));
  });

  it("rejects a malformed slug", () => {
    expect(() => buildPhp({ kind: "activate_theme", slug: "../evil" })).toThrow();
  });
});

describe("buildPhp — delete_theme", () => {
  it("re-checks parentage inside WordPress, not just in TypeScript", () => {
    const php = buildPhp({ kind: "delete_theme", slug: "storefront" });
    // The snapshot the UI gated on can be stale; WordPress is the authority.
    expect(php).toContain("get_stylesheet()");
    expect(php).toContain("get_template()");
    expect(php).toContain("delete_theme");
  });

  it("requires theme.php via a guard that is not a deprecated shim", () => {
    const php = buildPhp({ kind: "delete_theme", slug: "storefront" });
    expect(php).toContain("wp-admin/includes/theme.php");
    expect(php).not.toContain("function_exists('get_themes')");
  });

  it("rejects a malformed slug", () => {
    expect(() => buildPhp({ kind: "delete_theme", slug: "../evil" })).toThrow();
  });

  it("checks WP_Filesystem()'s return value instead of calling it bare", () => {
    const php = buildPhp({ kind: "delete_theme", slug: "storefront" });
    expect(php).not.toContain("WP_Filesystem();");
    expect(php).toContain("if (!WP_Filesystem())");
  });
});

function phpResult(payload: unknown) {
  return { success: true, data: { success: true, return_value: JSON.stringify(payload), output: "", errors: [] } };
}

function fakeDeps(mock: MockMcpClient) {
  const activity: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let credsEncrypted = "";
  const sites = {
    async getSiteCredentials(id: string) {
      return id === "site-1"
        ? { mcp_endpoint: "https://x/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: credsEncrypted }
        : null;
    },
    async insertActivity(e: Record<string, unknown>) { activity.push(e); },
  } as unknown as SitesRepo;
  const jobs = {
    async pendingExists() { return false; },
    async insert(j: Record<string, unknown>) { enqueued.push(j); return { id: "job-1" }; },
  } as unknown as JobsRepo;
  const deps: ManageDeps = { sites, jobs, mcp: async () => mock };
  return { deps, activity, enqueued, setCreds: (v: string) => { credsEncrypted = v; } };
}

describe("manageSite", () => {
  it("runs the PHP action, logs activity, enqueues snapshot refresh", async () => {
    const mock = new MockMcpClient({
      handler: (name, args) => {
        expect(name).toBe("novamira/execute-php");
        expect((args as { code: string }).code).toContain("activate_plugin(");
        return phpResult({ ok: true, message: "Plugin activated" });
      },
    });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await manageSite(f.deps, "site-1", "user-1", { kind: "activate_plugin", file: "akismet/akismet.php" });
    expect(res).toMatchObject({ ok: true, output: "Plugin activated" });
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ actor: "user-1", site_id: "site-1", action: "site.manage.activate_plugin" });
    expect(f.enqueued[0]).toMatchObject({ type: "snapshot_refresh", site_id: "site-1" });
  });

  it("surfaces PHP-level failures, logs them, does not enqueue refresh", async () => {
    const mock = new MockMcpClient({ handler: () => phpResult({ ok: false, error: "Plugin not found." }) });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await manageSite(f.deps, "site-1", "user-1", { kind: "update_plugin", file: "ghost/ghost.php" });
    expect(res).toMatchObject({ ok: false, error: "Plugin not found." });
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ action: "site.manage.update_plugin" });
    expect(f.enqueued).toHaveLength(0);
  });

  it("logs rejected invalid targets without opening a client", async () => {
    const mock = new MockMcpClient();
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await manageSite(f.deps, "site-1", "user-1", { kind: "update_plugin", file: "--allow-root" });
    expect(res.ok).toBe(false);
    expect(f.activity[0]).toMatchObject({ action: "site.manage.update_plugin" });
    expect((f.activity[0].detail as { rejected?: string }).rejected).toBe("invalid_target");
    expect(mock.calls).toHaveLength(0);
  });

  it("fails cleanly for an unknown site", async () => {
    const f = fakeDeps(new MockMcpClient());
    const res = await manageSite(f.deps, "nope", "user-1", { kind: "flush_cache" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });
});

/**
 * The self-update fatal.
 *
 *   PHP Fatal error ... novamira/vendor/jetpack-autoloader/class-php-autoloader.php:102
 *   #5 WP\MCP\Transport\HttpTransport->handle_request(Object(WP_REST_Request))
 *
 * update_all_plugins called bulk_upgrade() on every plugin with a pending
 * update -- including `novamira`, the plugin serving that very request. The
 * upgrade replaced its directory, execution returned up the stack into files
 * that no longer existed, and the next autoload fataled. All eight sites with
 * pending updates had novamira in that list, so it failed on every one.
 *
 * Probing the live fleet also found `seo-by-rank-math` on the call stack of
 * one site, which a hardcoded "skip novamira" would have missed.
 */
describe("buildPhp — self-update guard", () => {
  const ALL = () => buildPhp({ kind: "update_all_plugins" });
  const ONE = (file: string) => buildPhp({ kind: "update_plugin", file });

  it("discovers what is executing from the call stack, not a hardcoded name", () => {
    const php = ALL();
    expect(php).toContain("debug_backtrace");
    // A slug list would have been wrong the moment Rank Math joined the stack.
    expect(php).not.toMatch(/'novamira'|"novamira"/);
  });

  it("filters the upgrade list before the upgrader sees it", () => {
    const php = ALL();
    expect(php).toContain("$__self[ocs_plugin_dir_of($__file)]");
    expect(php.indexOf("$files = $kept;")).toBeGreaterThan(-1);
    expect(php.indexOf("bulk_upgrade($files)")).toBeGreaterThan(php.indexOf("$files = $kept;"));
  });

  it("reports a skip rather than silently dropping it", () => {
    // "Updated 11 plugins" while one was held back leaves an operator
    // believing the site is current when it is not.
    const php = ALL();
    expect(php).toContain("Skipped ");
    expect(php.slice(php.lastIndexOf("'ok' => true"))).toContain("$skipnote");
  });

  it("refuses a single update of the plugin serving the request", () => {
    const php = ONE("novamira/novamira.php");
    expect(php).toContain("cannot update itself");
    // Decided before any upgrade machinery runs.
    expect(php.indexOf("isset($__self[")).toBeLessThan(php.indexOf("bulk_upgrade"));
  });

  it("ships the runtime check for every plugin, not just the known one", () => {
    // The panel cannot tell from a slug whether that plugin hooks the REST
    // path on a given site -- El Nido Guide's Rank Math does, others' do not.
    for (const f of ["akismet/akismet.php", "seo-by-rank-math/rank-math.php"]) {
      expect(ONE(f)).toContain("isset($__self[ocs_plugin_dir_of($f)])");
    }
  });

  it("emits PHP containing no backslashes at all", () => {
    // Four bugs this session came from an escape sequence eaten by a layer of
    // string handling -- most recently a PHP regex whose \s reached the site
    // as a bare "s" and matched nothing. These snippets are written to need
    // no escaping; this pins that they stay that way.
    for (const php of [ALL(), ONE("akismet/akismet.php")]) {
      expect(php).not.toContain(String.fromCharCode(92));
    }
  });
});
