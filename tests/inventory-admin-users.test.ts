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

  it("throws before any snapshot write when the response is missing admin_users", async () => {
    const { admin_users: _omit, ...withoutAdmins } = RAW;
    await expect(collectInventory(fixtureClient(withoutAdmins))).rejects.toThrow(/admin_users/);
  });
});

describe("0011_site_admin_users.sql", () => {
  const SQL = readFileSync(
    path.join(__dirname, "../supabase/migrations/0011_site_admin_users.sql"),
    "utf8",
  );

  it("creates a staff-only site_admin_users table with RLS enabled", () => {
    // "if not exists": this migration has not been applied to any database
    // yet, so it is written to be re-run safely rather than to error on a
    // second run. This is not 0008_rls_scoped.sql's convention -- 0008
    // creates no tables, only policies -- it is a departure made because
    // this migration in particular may need a second, harmless run.
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

  it("does not carry the check-constraint backstop -- that ships separately, after deploy", () => {
    // The constraint has the opposite deploy-order dependency from the rest
    // of this migration: it would reject every snapshot write made by
    // still-deployed old code between "0011 applied" and "new build live".
    // See 0013_snapshot_no_admin_users.sql.
    expect(SQL).not.toContain("site_snapshots_no_admin_users");
  });
});

describe("0013_snapshot_no_admin_users.sql", () => {
  const SQL = readFileSync(
    path.join(__dirname, "../supabase/migrations/0013_snapshot_no_admin_users.sql"),
    "utf8",
  );

  it("backstops 0011's strip with a check constraint, dropped before it is re-added", () => {
    // Re-run safety within this migration: a second apply must not abort on
    // `add constraint` already existing.
    const dropIndex = SQL.indexOf("drop constraint if exists site_snapshots_no_admin_users");
    const addIndex = SQL.indexOf("add constraint site_snapshots_no_admin_users");
    expect(dropIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(dropIndex);
    expect(SQL).toMatch(/check \(not \(payload \? 'admin_users'\)\)/);
  });

  it("re-runs the admin_users strip immediately before adding the constraint", () => {
    // `add constraint` with no `not valid` clause makes Postgres validate
    // every existing row. 0011's strip is one-shot and only cleans rows
    // present when 0011 ran; the still-deployed old collectInventory keeps
    // inserting new admin_users-carrying rows into this insert-only history
    // table (site_snapshots) during the gap between 0011 and this branch's
    // deploy. Without a second strip here, `add constraint` aborts on those
    // gap rows against the very database this migration is written for.
    const stripIndex = SQL.indexOf(
      "update site_snapshots set payload = payload - 'admin_users' where payload ? 'admin_users';",
    );
    const dropIndex = SQL.indexOf("drop constraint if exists site_snapshots_no_admin_users");
    const addIndex = SQL.indexOf("add constraint site_snapshots_no_admin_users");
    expect(stripIndex).toBeGreaterThan(-1);
    expect(stripIndex).toBeLessThan(dropIndex);
    expect(dropIndex).toBeLessThan(addIndex);
  });

  it("documents that it must be applied only after this branch's code is deployed", () => {
    expect(SQL).toMatch(/applied only after|apply this (constraint|migration) (only )?after/i);
  });
});
