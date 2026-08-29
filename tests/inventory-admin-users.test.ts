import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { collectInventory, INVENTORY_PHP } from "@/services/inventory/service";
import { MockMcpClient } from "@/lib/mcp/mock";

// Spec §5.1 / task 7: a client granted a site can read that site's
// site_snapshots row over PostgREST. RLS cannot filter inside a JSONB
// column, so admin_users has to live outside InventoryPayload entirely,
// in its own staff-only table (0011_site_admin_users.sql).

const RAW = {
  wp_version: "6.7.1",
  php_version: "8.2.20",
  admin_url: "https://example.com/wp-admin/",
  core_update: null,
  plugins: [],
  themes: [],
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

describe("admin_users no longer lives in the stored inventory payload", () => {
  it("INVENTORY_PHP still gathers admins, but as a sibling key, not nested under anything payload-shaped", () => {
    expect(INVENTORY_PHP).toContain("'admin_users' => $admins");
  });

  it("collectInventory returns admins separately from the payload it stores", async () => {
    const { payload, adminUsers } = await collectInventory(fixtureClient());
    expect(adminUsers).toEqual(RAW.admin_users);
    expect(payload).not.toHaveProperty("admin_users");
    expect(Object.keys(payload).sort()).toEqual(
      ["admin_url", "collected_at", "core_update", "php_version", "plugins", "themes", "wp_version"].sort(),
    );
  });
});

describe("0011_site_admin_users.sql", () => {
  const SQL = readFileSync(
    path.join(__dirname, "../supabase/migrations/0011_site_admin_users.sql"),
    "utf8",
  );

  it("creates a staff-only site_admin_users table with RLS enabled", () => {
    // "if not exists": this migration has not been applied to any database
    // yet, so, per 0008_rls_scoped.sql's convention, it is written to be
    // re-run safely rather than to error on a second run.
    expect(SQL).toMatch(/create table if not exists site_admin_users\s*\(/);
    expect(SQL).toMatch(/alter table site_admin_users enable row level security;/);
  });

  it("drops the read policy before recreating it, for the same re-run safety", () => {
    expect(SQL).toContain("drop policy if exists site_admin_users_read on site_admin_users;");
  });

  it("gates reads on sites.view_all, to authenticated, wrapped as a subselect", () => {
    const m = SQL.match(/create policy site_admin_users_read on site_admin_users[\s\S]*?;/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/for select to authenticated/);
    expect(m![0]).toMatch(/\(select authorize\('sites\.view_all'\)\)/);
  });

  it("strips admin_users from every already-scanned site_snapshots row", () => {
    expect(SQL).toContain(
      "update site_snapshots set payload = payload - 'admin_users' where payload ? 'admin_users';",
    );
  });

  it("backstops the strip with a check constraint, added after the strip and re-run safe", () => {
    const stripIndex = SQL.indexOf(
      "update site_snapshots set payload = payload - 'admin_users' where payload ? 'admin_users';",
    );
    const dropIndex = SQL.indexOf("drop constraint if exists site_snapshots_no_admin_users");
    const addIndex = SQL.indexOf("add constraint site_snapshots_no_admin_users");
    expect(stripIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(stripIndex);
    expect(addIndex).toBeGreaterThan(dropIndex);
    expect(SQL).toMatch(/check \(not \(payload \? 'admin_users'\)\)/);
  });
});
