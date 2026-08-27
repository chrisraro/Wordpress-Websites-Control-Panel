import { describe, it, expect } from "vitest";
import { collectInventory } from "@/services/inventory/service";
import { pendingUpdates, type InventoryPayload } from "@/services/inventory/types";
import { MockMcpClient } from "@/lib/mcp/mock";

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
