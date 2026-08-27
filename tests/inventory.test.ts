import { describe, it, expect, beforeAll } from "vitest";
import { collectInventory, refreshSnapshot } from "@/services/inventory/service";
import { pendingUpdates, type InventoryPayload } from "@/services/inventory/types";
import { MockMcpClient } from "@/lib/mcp/mock";
import { randomBytes } from "node:crypto";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SitesRepo } from "@/services/sites/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";

const CLI_FIXTURES: Record<string, unknown> = {
  "core version": "6.7.1",
  "eval 'echo PHP_VERSION;'": "8.2.20",
  "plugin list --format=json --fields=name,title,version,status,update,update_version":
    '[{"name":"akismet","title":"Akismet","version":"5.3","status":"active","update":"available","update_version":"5.4"},' +
    '{"name":"hello","title":"Hello Dolly","version":"1.7","status":"inactive","update":"none","update_version":null}]',
  "theme list --format=json --fields=name,title,version,status,update,update_version":
    '[{"name":"generatepress","title":"GeneratePress","version":"3.4","status":"active","update":"none","update_version":null}]',
  "core check-update --format=json":
    '[{"version":"6.8","update_type":"major"}]',
  "user list --role=administrator --format=json --fields=ID,user_login,user_email":
    '[{"ID":1,"user_login":"admin","user_email":"a@b.co"}]',
};

function fixtureClient(overrides: Record<string, unknown> = {}) {
  const table = { ...CLI_FIXTURES, ...overrides };
  return new MockMcpClient({
    handler: (name, args) => {
      if (name !== "novamira/run-wp-cli") throw new Error(`unexpected ability ${name}`);
      const cmd = (args as { command: string }).command;
      if (!(cmd in table)) throw new Error(`no fixture for command: ${cmd}`);
      return { stdout: String(table[cmd]), exit_code: 0 };
    },
  });
}

describe("collectInventory", () => {
  it("collects versions, plugins, themes, core update, and admins", async () => {
    const inv = await collectInventory(fixtureClient());
    expect(inv.wp_version).toBe("6.7.1");
    expect(inv.php_version).toBe("8.2.20");
    expect(inv.core_update).toBe("6.8");
    expect(inv.plugins).toHaveLength(2);
    expect(inv.plugins[0]).toMatchObject({ name: "akismet", update: "available" });
    expect(inv.themes[0].name).toBe("generatepress");
    expect(inv.admin_users[0].user_login).toBe("admin");
    expect(inv.collected_at).toMatch(/^\d{4}-/);
  });

  it("treats 'Success: latest version' as no core update", async () => {
    const inv = await collectInventory(fixtureClient({
      "core check-update --format=json": "Success: WordPress is at the latest version.",
    }));
    expect(inv.core_update).toBeNull();
  });
});

describe("pendingUpdates", () => {
  it("counts plugin + theme + core updates", async () => {
    const inv = await collectInventory(fixtureClient());
    // 1 plugin update + 0 theme updates + 1 core update
    expect(pendingUpdates(inv)).toBe(2);
  });
  it("is zero when everything is current", async () => {
    const inv = await collectInventory(fixtureClient({
      "plugin list --format=json --fields=name,title,version,status,update,update_version": "[]",
      "theme list --format=json --fields=name,title,version,status,update,update_version": "[]",
      "core check-update --format=json": "Success: WordPress is at the latest version.",
    }));
    expect(pendingUpdates(inv)).toBe(0);
  });
});

describe("refreshSnapshot", () => {
  beforeAll(() => {
    process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  function deps(mock: MockMcpClient, encrypted: string) {
    const stored: Array<{ siteId: string; payload: InventoryPayload }> = [];
    const sites = {
      async getSiteCredentials(id: string) {
        return id === "site-1"
          ? { mcp_endpoint: "https://x/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: encrypted }
          : null;
      },
    } as unknown as SitesRepo;
    const snapshots: SnapshotsRepo = {
      async insertSnapshot(siteId, payload) { stored.push({ siteId, payload }); },
      async latestSnapshot() { return null; },
    };
    return { deps: { sites, snapshots, mcp: async () => mock }, stored };
  }

  it("collects, stores, and closes the client", async () => {
    const mock = fixtureClient();
    const f = deps(mock, await encryptSecret("pass"));
    const payload = await refreshSnapshot(f.deps, "site-1");
    expect(payload.wp_version).toBe("6.7.1");
    expect(f.stored[0]).toMatchObject({ siteId: "site-1" });
    expect(mock.closed).toBe(true);
  });

  it("closes the client even when storing fails", async () => {
    const mock = fixtureClient();
    const f = deps(mock, await encryptSecret("pass"));
    f.deps.snapshots.insertSnapshot = async () => { throw new Error("db down"); };
    await expect(refreshSnapshot(f.deps, "site-1")).rejects.toThrow("db down");
    expect(mock.closed).toBe(true);
  });

  it("throws for an unknown site without opening a client", async () => {
    const mock = fixtureClient();
    const f = deps(mock, await encryptSecret("pass"));
    await expect(refreshSnapshot(f.deps, "nope")).rejects.toThrow(/not found/i);
    expect(mock.closed).toBe(false);
  });
});
