import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { buildCommands, manageSite } from "@/services/manage/service";
import type { ManageDeps } from "@/services/manage/service";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("buildCommands", () => {
  it("maps every action kind to WP-CLI commands", () => {
    expect(buildCommands({ kind: "update_core" })).toEqual(["core update", "core update-db"]);
    expect(buildCommands({ kind: "update_plugin", slug: "akismet" })).toEqual(["plugin update akismet"]);
    expect(buildCommands({ kind: "update_all_plugins" })).toEqual(["plugin update --all"]);
    expect(buildCommands({ kind: "update_theme", slug: "generatepress" })).toEqual(["theme update generatepress"]);
    expect(buildCommands({ kind: "activate_plugin", slug: "akismet" })).toEqual(["plugin activate akismet"]);
    expect(buildCommands({ kind: "deactivate_plugin", slug: "akismet" })).toEqual(["plugin deactivate akismet"]);
    expect(buildCommands({ kind: "maintenance", enable: true })).toEqual(["maintenance-mode activate"]);
    expect(buildCommands({ kind: "maintenance", enable: false })).toEqual(["maintenance-mode deactivate"]);
    expect(buildCommands({ kind: "flush_cache" })).toEqual(["cache flush"]);
    expect(buildCommands({ kind: "flush_permalinks" })).toEqual(["rewrite flush --hard"]);
  });

  it("rejects slug injection attempts", () => {
    for (const bad of ["a; rm -rf /", "a && b", "a b", "a`b`", "a$(x)", "", "a|b", "--allow-root", "-x", "a\nb"]) {
      expect(() => buildCommands({ kind: "update_plugin", slug: bad })).toThrow(/invalid slug/i);
    }
  });
});

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
  it("runs the command, logs activity, enqueues snapshot refresh", async () => {
    const mock = new MockMcpClient({ handler: () => ({ stdout: "Success: Updated 1 of 1 plugins.", exit_code: 0 }) });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await manageSite(f.deps, "site-1", "user-1", { kind: "update_plugin", slug: "akismet" });
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/Success/);
    expect(mock.calls[0].args).toMatchObject({ command: "plugin update akismet" });
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ actor: "user-1", site_id: "site-1", action: "site.manage.update_plugin" });
    expect(f.enqueued[0]).toMatchObject({ type: "snapshot_refresh", site_id: "site-1" });
  });

  it("returns ok:false with the error, logs the failure, does not enqueue refresh", async () => {
    const mock = new MockMcpClient({ handler: () => ({ stdout: "", stderr: "Error: plugin not found", exit_code: 1 }) });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await manageSite(f.deps, "site-1", "user-1", { kind: "update_plugin", slug: "ghost" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/plugin not found/);
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ action: "site.manage.update_plugin" });
    expect(f.enqueued).toHaveLength(0);
  });

  it("fails cleanly for an unknown site", async () => {
    const f = fakeDeps(new MockMcpClient());
    const res = await manageSite(f.deps, "nope", "user-1", { kind: "flush_cache" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("logs rejected invalid-slug attempts", async () => {
    const mock = new MockMcpClient();
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await manageSite(f.deps, "site-1", "user-1", { kind: "update_plugin", slug: "--allow-root" });
    expect(res.ok).toBe(false);
    expect(f.activity[0]).toMatchObject({ action: "site.manage.update_plugin" });
    expect(mock.calls).toHaveLength(0);
  });
});
