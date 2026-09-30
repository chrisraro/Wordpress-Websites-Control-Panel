import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import { SETUP_UPDRAFT_PHP, setupUpdraft } from "@/services/backup/setup";

/**
 * "Set up backups": install UpdraftPlus where it is missing, then make sure
 * Google Drive is a destination and a schedule is actually registered.
 * Drive authorization itself is a Google consent screen and cannot be done
 * by the panel; the result reports whether it is still needed.
 */

let encrypted = "";
beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  encrypted = await encryptSecret("pass");
});

type Configured = { state: "configured"; activated: boolean; changed: string[]; drive_authorized: boolean; next_backup: number | null };

function site(opts: { installed: boolean; installOk?: boolean; configured?: Partial<Configured> }) {
  let installed = opts.installed;
  const calls: string[] = [];
  const mock = new MockMcpClient({
    handler: (_name, args) => {
      const code = (args as { code: string }).code;
      let value: unknown;
      if (code.includes("Plugin_Upgrader")) {
        calls.push("install");
        if (opts.installOk !== false) installed = true;
        value = opts.installOk === false ? { ok: false, error: "Download failed" } : { ok: true, message: "Installed and activated" };
      } else if (code === SETUP_UPDRAFT_PHP) {
        calls.push("configure");
        value = installed
          ? { state: "configured", activated: false, changed: [], drive_authorized: false, next_backup: 1_790_000_000, ...opts.configured }
          : { state: "not_installed" };
      } else {
        throw new Error("unexpected PHP");
      }
      return { success: true, data: { success: true, return_value: JSON.stringify(value), output: "", errors: [] } };
    },
  });
  return { mock, calls };
}

function deps(mock: MockMcpClient) {
  const activity: Array<Record<string, unknown>> = [];
  const enqueued: string[] = [];
  return {
    activity,
    enqueued,
    deps: {
      sites: {
        async getSiteCredentials(id: string) {
          return id === "site-1"
            ? { mcp_endpoint: "https://x.example/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: encrypted }
            : null;
        },
        async insertActivity(row: Record<string, unknown>) { activity.push(row); },
      },
      jobs: {
        async pendingExists() { return false; },
        async insert(row: { type: string }) { enqueued.push(row.type); return { id: "job-1" }; },
      },
      mcp: async () => mock,
    } as unknown as Parameters<typeof setupUpdraft>[0],
  };
}

describe("setupUpdraft", () => {
  it("configures a site that already has UpdraftPlus, without installing", async () => {
    const { mock, calls } = site({ installed: true, configured: { changed: ["remote storage: Google Drive added"] } });
    const { deps: d, activity } = deps(mock);
    const r = await setupUpdraft(d, "site-1", "actor-1");
    expect(calls).toEqual(["configure"]);
    expect(r).toMatchObject({ installed: false, driveAuthorized: false, changed: ["remote storage: Google Drive added"] });
    expect(activity.at(-1)).toMatchObject({ action: "site.backup_setup", site_id: "site-1", actor: "actor-1" });
  });

  it("installs UpdraftPlus from wordpress.org when missing, then configures it", async () => {
    const { mock, calls } = site({ installed: false });
    const { deps: d } = deps(mock);
    const r = await setupUpdraft(d, "site-1", "actor-1");
    expect(calls).toEqual(["configure", "install", "configure"]);
    expect(r.installed).toBe(true);
  });

  it("fails loudly when the install fails, and does not claim the site is set up", async () => {
    const { mock } = site({ installed: false, installOk: false });
    const { deps: d } = deps(mock);
    await expect(setupUpdraft(d, "site-1", "actor-1")).rejects.toThrow(/Download failed/);
  });

  it("reports an authorized Drive when the site already has a token", async () => {
    const { mock } = site({ installed: true, configured: { drive_authorized: true } });
    const { deps: d } = deps(mock);
    expect((await setupUpdraft(d, "site-1", "actor-1")).driveAuthorized).toBe(true);
  });

  it("never logs or returns anything from the Drive settings beyond the authorized flag", async () => {
    // The PHP itself only reports a boolean; pin that no token field is read out.
    expect(SETUP_UPDRAFT_PHP).not.toMatch(/'token'\s*=>/);
    expect(SETUP_UPDRAFT_PHP).toMatch(/drive_authorized/);
    // Adds Google Drive; never replaces a destination the site already uses.
    expect(SETUP_UPDRAFT_PHP).toMatch(/in_array\('googledrive'/);
  });
});
