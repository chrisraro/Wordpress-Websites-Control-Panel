import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SQL = readFileSync("supabase/migrations/0008_rls_scoped.sql", "utf8");

// SQL with line comments stripped, so prose mentioning "authorize()" or
// "has_site_access()" in a comment can never be mistaken for a real,
// unwrapped call by the wrapping check below.
const CODE = SQL.replace(/--.*$/gm, "");

const ORIGINAL_TABLES = [
  "sites",
  "site_snapshots",
  "vuln_feed",
  "site_vulnerabilities",
  "security_checks",
  "uptime_checks",
  "seo_snapshots",
  "geogrid_configs",
  "geogrid_snapshots",
  "reports",
  "jobs",
  "activity_log",
];

const RBAC_TABLES = ["user_roles", "role_permissions", "user_permission_overrides", "user_site_access"];

const ALL_TABLES = [...ORIGINAL_TABLES, ...RBAC_TABLES];

describe("0008_rls_scoped.sql", () => {
  it("drops team_all from every one of the 12 original tables, and nowhere else", () => {
    const drops = [...SQL.matchAll(/drop policy team_all on (\w+);/g)].map((m) => m[1]);
    expect(drops.sort()).toEqual([...ORIGINAL_TABLES].sort());
  });

  it("gives every one of the 16 tables at least one policy", () => {
    for (const t of ALL_TABLES) {
      expect(SQL).toMatch(new RegExp(`create policy \\w+ on ${t}\\b`));
    }
  });

  it("names `to authenticated` on every policy", () => {
    const blocks = SQL.split(/(?=create policy )/g).filter((b) => b.startsWith("create policy"));
    // One block per create-policy statement; sanity check we actually found them all.
    expect(blocks.length).toBe((SQL.match(/create policy \w+/g) ?? []).length);
    for (const block of blocks) {
      const end = block.indexOf(";");
      const stmt = end === -1 ? block : block.slice(0, end + 1);
      expect(stmt).toMatch(/\bto authenticated\b/);
    }
  });

  it("wraps every authorize()/has_site_access() call as (select ...)", () => {
    const calls = [...CODE.matchAll(/(\(select\s+)?\b(authorize|has_site_access)\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) {
      const context = CODE.slice(Math.max(0, m.index! - 15), m.index! + 40);
      expect(m[1], `unwrapped helper call near: ...${context}...`).toBeTruthy();
    }
  });

  it("does not let user_site_access's self-read policy call has_site_access (recursion trap)", () => {
    const m = SQL.match(/create policy user_site_access_select_own[\s\S]*?;/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/has_site_access/);
    expect(m![0]).toMatch(/user_id\s*=\s*\(select auth\.uid\(\)\)/);
  });

  it("scopes geogrid_snapshots through geogrid_configs, since it has no site_id column", () => {
    const m = SQL.match(/create policy geogrid_snapshots_scoped[\s\S]*?;/);
    expect(m).not.toBeNull();
    // Must join through geogrid_configs and reference ITS site_id...
    expect(m![0]).toMatch(/has_site_access\(geogrid_configs\.site_id\)/);
    expect(m![0]).toMatch(/geogrid_configs\.id = geogrid_snapshots\.config_id/);
    // ...never a bare, unqualified site_id (this table doesn't have one).
    expect(m![0]).not.toMatch(/has_site_access\(site_id\)/);
  });

  it("gates jobs and activity_log on sites.view_all only", () => {
    for (const t of ["jobs", "activity_log"]) {
      const m = SQL.match(new RegExp(`create policy \\w+ on ${t}\\b[\\s\\S]*?;`));
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/authorize\('sites\.view_all'\)/);
      expect(m![0]).not.toMatch(/has_site_access/);
    }
  });

  it("lets any authenticated user read vuln_feed and role_permissions with a bare `using (true)`", () => {
    for (const t of ["vuln_feed", "role_permissions"]) {
      const m = SQL.match(new RegExp(`create policy \\w+ on ${t}\\b[\\s\\S]*?;`));
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/using\s*\(\s*true\s*\)/);
    }
  });

  it("scopes every child table by has_site_access(site_id)", () => {
    const childTables = [
      "site_snapshots",
      "site_vulnerabilities",
      "security_checks",
      "uptime_checks",
      "seo_snapshots",
      "geogrid_configs",
      "reports",
    ];
    for (const t of childTables) {
      const m = SQL.match(new RegExp(`create policy \\w+ on ${t}\\b[\\s\\S]*?;`));
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/has_site_access\(site_id\)/);
    }
  });

  it("scopes sites by has_site_access(id) for reads and authorize('sites.manage') for writes", () => {
    const select = SQL.match(/create policy sites_select_scoped[\s\S]*?;/);
    const write = SQL.match(/create policy sites_write[\s\S]*?;/);
    expect(select).not.toBeNull();
    expect(write).not.toBeNull();
    expect(select![0]).toMatch(/has_site_access\(id\)/);
    expect(write![0]).toMatch(/authorize\('sites\.manage'\)/);
  });

  it("restricts the other three RBAC tables' self-read to a bare auth.uid() predicate", () => {
    for (const p of ["user_roles_select_own", "user_permission_overrides_select_own"]) {
      const m = SQL.match(new RegExp(`create policy ${p}[\\s\\S]*?;`));
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/user_id\s*=\s*\(select auth\.uid\(\)\)/);
      expect(m![0]).not.toMatch(/authorize|has_site_access/);
    }
  });

  it("gates every RBAC table's write path on users.manage", () => {
    for (const t of RBAC_TABLES) {
      const m = SQL.match(new RegExp(`create policy \\w*_manage on ${t}\\b[\\s\\S]*?;`));
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/authorize\('users\.manage'\)/);
    }
  });
});
