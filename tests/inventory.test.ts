import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { collectInventory, refreshSnapshot, INVENTORY_PHP } from "@/services/inventory/service";
import { pendingUpdates, type InventoryPayload } from "@/services/inventory/types";
import type { SnapshotsRepo } from "@/services/inventory/repo";
import type { SitesRepo } from "@/services/sites/repo";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";

const RAW = {
  wp_version: "6.7.1",
  php_version: "8.2.20",
  core_update: "6.8",
  plugins: [
    { file: "akismet/akismet.php", name: "akismet", title: "Akismet", version: "5.3", status: "active", update: "available", update_version: "5.4" },
    { file: "hello.php", name: "hello", title: "Hello Dolly", version: "1.7", status: "inactive", update: "none", update_version: null },
  ],
  themes: [
    { name: "generatepress", title: "GeneratePress", version: "3.4", status: "active", update: "none", update_version: null },
  ],
  admin_users: [{ ID: 1, user_login: "admin", user_email: "a@b.co" }],
};

function fixtureClient(raw: unknown = RAW) {
  return new MockMcpClient({
    handler: (name, args) => {
      if (name !== "novamira/execute-php") throw new Error(`unexpected ability ${name}`);
      const code = (args as { code: string }).code;
      if (!code.includes("get_plugins")) throw new Error("unexpected snippet");
      return { success: true, data: { success: true, return_value: JSON.stringify(raw), output: "", errors: [] } };
    },
  });
}

describe("collectInventory", () => {
  it("collects the payload through a single execute-php call", async () => {
    const client = fixtureClient();
    const inv = await collectInventory(client);
    expect(inv.wp_version).toBe("6.7.1");
    expect(inv.php_version).toBe("8.2.20");
    expect(inv.core_update).toBe("6.8");
    expect(inv.plugins[0]).toMatchObject({ file: "akismet/akismet.php", name: "akismet", update: "available" });
    expect(inv.themes[0].name).toBe("generatepress");
    expect(inv.admin_users[0].user_login).toBe("admin");
    expect(inv.collected_at).toMatch(/^\d{4}-/);
    expect(client.calls).toHaveLength(1);
  });

  it("uses a snippet that refreshes update transients inside WordPress", () => {
    for (const marker of ["wp_update_plugins()", "wp_update_themes()", "wp_version_check()", "return json_encode"]) {
      expect(INVENTORY_PHP).toContain(marker);
    }
  });
});

describe("pendingUpdates", () => {
  const base: InventoryPayload = { ...RAW, collected_at: "2026-01-01T00:00:00Z" };
  it("counts plugin + theme + core updates", () => {
    expect(pendingUpdates(base)).toBe(2); // 1 plugin + 0 themes + core
  });
  it("is zero when everything is current", () => {
    expect(pendingUpdates({ ...base, core_update: null, plugins: [], themes: [] })).toBe(0);
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
