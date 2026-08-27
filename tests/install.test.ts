import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { buildInstallPhp, installPlugin } from "@/services/marketplace/install";
import type { InstallDeps } from "@/services/marketplace/install";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("buildInstallPhp", () => {
  it("builds a wp.org install with base64 slug and latest-stable zip", () => {
    const code = buildInstallPhp({ kind: "wporg", slug: "akismet" }, true);
    expect(code).toContain(`base64_decode('${b64("akismet")}')`);
    expect(code).toContain("downloads.wordpress.org/plugin/");
    expect(code).toContain("Plugin_Upgrader");
    expect(code).toContain("activate_plugin");
    expect(code).toContain("return json_encode");
  });
  it("omits activation when activate=false", () => {
    const code = buildInstallPhp({ kind: "wporg", slug: "akismet" }, false);
    expect(code).not.toContain("activate_plugin");
  });
  it("builds a URL install with the base64 URL embedded", () => {
    const url = "https://x.supabase.co/storage/v1/object/sign/plugins/u/a.zip?token=t";
    const code = buildInstallPhp({ kind: "url", url }, false);
    expect(code).toContain(`base64_decode('${b64(url)}')`);
    expect(code).not.toContain("token=t'"); // never raw
  });
  it("short-circuits already-installed wp.org plugins instead of failing on folder_exists", () => {
    const withActivate = buildInstallPhp({ kind: "wporg", slug: "akismet" }, true);
    expect(withActivate).toContain("Already installed");
    expect(withActivate).toContain("is_plugin_active($existing)");
    const without = buildInstallPhp({ kind: "wporg", slug: "akismet" }, false);
    expect(without).toContain("Already installed");
    expect(without).not.toContain("is_plugin_active");
  });
  it("uses overwrite_package for URL installs (deliberate reinstalls) but not wp.org", () => {
    expect(buildInstallPhp({ kind: "url", url: "https://x/y.zip" }, false))
      .toContain("'overwrite_package' => true");
    expect(buildInstallPhp({ kind: "wporg", slug: "akismet" }, false))
      .not.toContain("overwrite_package' => true");
  });
  it("strips query strings from upgrader skin messages before surfacing errors", () => {
    const code = buildInstallPhp({ kind: "url", url: "https://x/y.zip" }, false);
    expect(code).toContain("preg_replace('/\\?\\S*/'");
  });
  it("rejects bad slugs and non-https URLs", () => {
    expect(() => buildInstallPhp({ kind: "wporg", slug: "a;b" }, false)).toThrow(/invalid slug/i);
    expect(() => buildInstallPhp({ kind: "wporg", slug: "--flag" }, false)).toThrow(/invalid slug/i);
    expect(() => buildInstallPhp({ kind: "url", url: "http://insecure/x.zip" }, false)).toThrow(/https/i);
    expect(() => buildInstallPhp({ kind: "url", url: "ftp://x" }, false)).toThrow(/https/i);
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
  const deps: InstallDeps = { sites, jobs, mcp: async () => mock };
  return { deps, activity, enqueued, setCreds: (v: string) => { creds = v; } };
}

describe("installPlugin", () => {
  it("installs, logs activity, enqueues snapshot refresh", async () => {
    const mock = new MockMcpClient({
      handler: (name, args) => {
        expect(name).toBe("novamira/execute-php");
        expect((args as { code: string }).code).toContain("Plugin_Upgrader");
        return phpResult({ ok: true, message: "Installed and activated", file: "akismet/akismet.php" });
      },
    });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await installPlugin(f.deps, "site-1", "user-1", { kind: "wporg", slug: "akismet" }, true);
    expect(res).toMatchObject({ ok: true, output: "Installed and activated" });
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ actor: "user-1", site_id: "site-1", action: "site.plugin_install" });
    expect(f.enqueued[0]).toMatchObject({ type: "snapshot_refresh" });
  });
  it("surfaces failure without enqueueing refresh", async () => {
    const mock = new MockMcpClient({ handler: () => phpResult({ ok: false, error: "Download failed." }) });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await installPlugin(f.deps, "site-1", "user-1", { kind: "wporg", slug: "ghost" }, false);
    expect(res).toMatchObject({ ok: false, error: "Download failed." });
    expect(f.enqueued).toHaveLength(0);
    expect(f.activity[0]).toMatchObject({ action: "site.plugin_install" });
  });
  it("logs rejected invalid sources without opening a client", async () => {
    const mock = new MockMcpClient();
    const f = fakeDeps(mock);
    const res = await installPlugin(f.deps, "site-1", "user-1", { kind: "wporg", slug: "a;b" }, false);
    expect(res.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
    expect(f.activity[0]).toMatchObject({ action: "site.plugin_install" });
  });
});
