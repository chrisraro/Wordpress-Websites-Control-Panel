import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { collectInventory, refreshSnapshot, INVENTORY_PHP } from "@/services/inventory/service";
import { pendingUpdates, type InventoryPayload } from "@/services/inventory/types";
import type { AdminUsersRepo, SnapshotsRepo } from "@/services/inventory/repo";
import type { SitesRepo } from "@/services/sites/repo";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";

const RAW = {
  wp_version: "6.7.1",
  php_version: "8.2.20",
  admin_url: "https://example.com/wp-admin/",
  core_update: "6.8",
  plugins: [
    { file: "akismet/akismet.php", name: "akismet", title: "Akismet", version: "5.3", status: "active", update: "available", update_version: "5.4" },
    { file: "hello.php", name: "hello", title: "Hello Dolly", version: "1.7", status: "inactive", update: "none", update_version: null },
  ],
  themes: [
    { name: "generatepress", template: "generatepress", title: "GeneratePress", version: "3.4", status: "active", update: "none", update_version: null },
  ],
};

const ADMIN_USERS = [{ ID: 1, user_login: "admin", user_email: "a@b.co" }];

// The wire shape WordPress actually returns: admin_users rides alongside
// the rest of the inventory in the same execute-php round trip. See
// tests/inventory-admin-users.test.ts for the split that keeps it out of
// the stored InventoryPayload.
function fixtureClient(raw: unknown = { ...RAW, admin_users: ADMIN_USERS }) {
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
    const { payload } = await collectInventory(client);
    expect(payload.wp_version).toBe("6.7.1");
    expect(payload.php_version).toBe("8.2.20");
    expect(payload.admin_url).toBe("https://example.com/wp-admin/");
    expect(payload.core_update).toBe("6.8");
    expect(payload.plugins[0]).toMatchObject({ file: "akismet/akismet.php", name: "akismet", update: "available" });
    expect(payload.themes[0].name).toBe("generatepress");
    expect(payload.themes[0].template).toBe("generatepress");
    expect(payload.collected_at).toMatch(/^\d{4}-/);
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
    const storedAdmins: Array<{ siteId: string; users: unknown }> = [];
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
    const adminUsers: AdminUsersRepo = {
      async upsertAdminUsers(siteId, users) { storedAdmins.push({ siteId, users }); },
      async latestAdminUsers() { return null; },
    };
    return { deps: { sites, snapshots, adminUsers, mcp: async () => mock }, stored, storedAdmins };
  }

  it("collects, stores, and closes the client", async () => {
    const mock = fixtureClient();
    const f = deps(mock, await encryptSecret("pass"));
    const payload = await refreshSnapshot(f.deps, "site-1");
    expect(payload.wp_version).toBe("6.7.1");
    expect(f.stored[0]).toMatchObject({ siteId: "site-1" });
    // toMatchObject is a partial match, so it alone would not catch a
    // regression that stops stripping admin_users off the stored payload
    // (see 0011_site_admin_users.sql's site_snapshots_no_admin_users check,
    // which is the database-level backstop for the same invariant).
    expect(f.stored[0].payload).not.toHaveProperty("admin_users");
    expect(f.storedAdmins[0]).toEqual({ siteId: "site-1", users: ADMIN_USERS });
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
