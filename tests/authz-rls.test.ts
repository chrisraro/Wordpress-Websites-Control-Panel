import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Resolved relative to this test file, not the process cwd, so the test
// passes whether vitest is invoked from the repo root or elsewhere.
const MIGRATION_PATH = path.join(__dirname, "../supabase/migrations/0008_rls_scoped.sql");
const SQL = readFileSync(MIGRATION_PATH, "utf8");

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

// Child tables scoped by has_site_access(site_id) directly (as opposed to
// sites, which scopes by has_site_access(id), and geogrid_snapshots, which
// scopes through a join since it has no site_id column of its own).
const CHILD_TABLES_BY_SITE_ID = [
  "site_snapshots",
  "site_vulnerabilities",
  "security_checks",
  "uptime_checks",
  "seo_snapshots",
  "geogrid_configs",
  "reports",
];

/** Every `create policy ...;` statement in the file, as raw text blocks. */
function policyBlocks(sql: string): string[] {
  return sql
    .split(/(?=create policy )/g)
    .filter((b) => b.startsWith("create policy"))
    .map((b) => {
      const end = b.indexOf(";");
      return end === -1 ? b : b.slice(0, end + 1);
    });
}

/** All `create policy ...;` blocks that apply to a given table. */
function policiesOnTable(sql: string, table: string): string[] {
  return policyBlocks(sql).filter((b) => new RegExp(`^create policy \\w+ on ${table}\\b`).test(b));
}

/** The `for <command>` clause of a single policy block, e.g. "select" or "all". */
function commandOf(block: string): string {
  const m = block.match(/\bfor\s+(select|insert|update|delete|all)\b/i);
  expect(m, `no "for <command>" clause found in: ${block}`).not.toBeNull();
  return m![1].toLowerCase();
}

describe("0008_rls_scoped.sql", () => {
  it("drops team_all (if exists) from every one of the 12 original tables, and nowhere else", () => {
    const drops = [...SQL.matchAll(/drop policy if exists team_all on (\w+);/g)].map((m) => m[1]);
    expect(drops.sort()).toEqual([...ORIGINAL_TABLES].sort());
  });

  it("guards every drop with `if exists`, for idempotent re-runs", () => {
    const drops = [...SQL.matchAll(/drop policy\s+(if exists\s+)?\w+ on \w+;/g)];
    expect(drops.length).toBeGreaterThan(0);
    for (const m of drops) {
      expect(m[0], `drop without "if exists": ${m[0]}`).toMatch(/^drop policy if exists /);
    }
  });

  it("sets a local search_path near the top, so helper calls need no schema qualification", () => {
    expect(SQL).toMatch(/set local search_path\s*=\s*public;/);
    // Must precede the first policy statement.
    const searchPathIdx = SQL.search(/set local search_path/);
    const firstPolicyIdx = SQL.search(/create policy /);
    expect(searchPathIdx).toBeGreaterThan(-1);
    expect(searchPathIdx).toBeLessThan(firstPolicyIdx);
  });

  it("never schema-qualifies the authorize/has_site_access helper calls", () => {
    expect(CODE).not.toMatch(/public\.(authorize|has_site_access)\(/);
  });

  it("gives every one of the 16 tables at least one policy", () => {
    for (const t of ALL_TABLES) {
      expect(SQL).toMatch(new RegExp(`create policy \\w+ on ${t}\\b`));
    }
  });

  it("names `to authenticated` on every policy", () => {
    const blocks = policyBlocks(SQL);
    // One block per create-policy statement; sanity check we actually found them all.
    expect(blocks.length).toBe((SQL.match(/create policy \w+/g) ?? []).length);
    for (const stmt of blocks) {
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
    const blocks = policiesOnTable(SQL, "geogrid_snapshots");
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      // Must join through geogrid_configs and reference ITS site_id...
      expect(block).toMatch(/has_site_access\(geogrid_configs\.site_id(,\s*'manage')?\)/);
      expect(block).toMatch(/geogrid_configs\.id = geogrid_snapshots\.config_id/);
      // ...never a bare, unqualified site_id (this table doesn't have one).
      expect(block).not.toMatch(/has_site_access\(site_id/);
    }
    const read = blocks.find((b) => commandOf(b) === "select")!;
    const write = blocks.find((b) => commandOf(b) === "all")!;
    expect(read, "expected a `for select` policy on geogrid_snapshots").toBeTruthy();
    expect(write, "expected a `for all` policy on geogrid_snapshots").toBeTruthy();
    expect(read).not.toMatch(/'manage'/);
    expect(write).toMatch(/has_site_access\(geogrid_configs\.site_id, 'manage'\)/);
  });

  it("gates jobs and activity_log on sites.view_all, for select only, with no write policy", () => {
    for (const t of ["jobs", "activity_log"]) {
      const blocks = policiesOnTable(SQL, t);
      expect(blocks.length, `expected exactly one policy on ${t}`).toBe(1);
      const [block] = blocks;
      expect(commandOf(block), `${t}'s sole policy must be "for select"`).toBe("select");
      expect(block).toMatch(/authorize\('sites\.view_all'\)/);
      expect(block).not.toMatch(/has_site_access/);
      // No "with check" anywhere -- a select-only policy has no write side,
      // and there must be no second policy supplying one.
      expect(block).not.toMatch(/with check/);
    }
  });

  it("lets any authenticated user read vuln_feed and role_permissions with a bare `using (true)`", () => {
    for (const t of ["vuln_feed", "role_permissions"]) {
      const m = SQL.match(new RegExp(`create policy \\w+ on ${t}\\b[\\s\\S]*?;`));
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/using\s*\(\s*true\s*\)/);
    }
  });

  it("splits every child table into exactly one read policy (select, read level) and one write policy (all, manage level)", () => {
    for (const t of CHILD_TABLES_BY_SITE_ID) {
      const blocks = policiesOnTable(SQL, t);
      expect(blocks.length, `expected exactly 2 policies on ${t}, found ${blocks.length}`).toBe(2);

      const read = blocks.find((b) => commandOf(b) === "select");
      const write = blocks.find((b) => commandOf(b) === "all");
      expect(read, `expected a "for select" policy on ${t}`).toBeTruthy();
      expect(write, `expected a "for all" policy on ${t}`).toBeTruthy();

      // Read policy: has_site_access(site_id) at the default 'read' level --
      // no explicit level argument, and definitely not 'manage'.
      expect(read!).toMatch(new RegExp(`has_site_access\\(site_id\\)`));
      expect(read!).not.toMatch(/'manage'/);

      // Write policy: has_site_access(site_id, 'manage') on both using and
      // with check -- a read-level grant must not satisfy it.
      const manageCalls = [...write!.matchAll(/has_site_access\(site_id,\s*'manage'\)/g)];
      expect(manageCalls.length, `${t}'s write policy must gate both using and with check on 'manage'`).toBe(2);
      expect(write!).toMatch(/\bwith check\b/);
    }
  });

  it("scopes sites by has_site_access(id) for reads and authorize('sites.manage') for writes", () => {
    const select = SQL.match(/create policy sites_select_scoped[\s\S]*?;/);
    const write = SQL.match(/create policy sites_write[\s\S]*?;/);
    expect(select).not.toBeNull();
    expect(write).not.toBeNull();
    expect(commandOf(select![0])).toBe("select");
    expect(commandOf(write![0])).toBe("all");
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
      expect(commandOf(m![0])).toBe("all");
      expect(m![0]).toMatch(/authorize\('users\.manage'\)/);
    }
  });

  it("asserts the exact policy-command shape for every table (catches for-all/for-select drift)", () => {
    const expectedCommands: Record<string, string[]> = {
      sites: ["select", "all"],
      site_snapshots: ["select", "all"],
      site_vulnerabilities: ["select", "all"],
      security_checks: ["select", "all"],
      uptime_checks: ["select", "all"],
      seo_snapshots: ["select", "all"],
      geogrid_configs: ["select", "all"],
      geogrid_snapshots: ["select", "all"],
      reports: ["select", "all"],
      jobs: ["select"],
      activity_log: ["select"],
      vuln_feed: ["select"],
      user_roles: ["select", "all"],
      role_permissions: ["select", "all"],
      user_permission_overrides: ["select", "all"],
      user_site_access: ["select", "all"],
    };

    for (const [table, expected] of Object.entries(expectedCommands)) {
      const blocks = policiesOnTable(SQL, table);
      const commands = blocks.map(commandOf).sort();
      expect(commands, `policy commands for ${table}`).toEqual([...expected].sort());
    }
  });
});
