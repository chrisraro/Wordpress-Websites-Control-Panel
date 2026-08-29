import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Finding 4 of the final whole-branch review: src/services/users/guards.ts's
// last-admin rule (canChangeRole / canDeleteUser) is evaluated in
// application code with no transaction spanning the read and the write, so
// two admins demoting each other inside the same second can both pass the
// guard and both commit, leaving zero rows with role = 'admin' -- a state
// spec §4 declares must be impossible and whose only recovery is raw SQL
// against production. This is a source-scan of the migration's shape, the
// same style tests/inventory-admin-users.test.ts uses for 0011/0013,
// because the property under test -- "this trigger fires on UPDATE/DELETE
// but never on INSERT, and evaluates once per statement" -- is a property
// of the SQL text, not of any TypeScript this repo can import and run.

const SQL = readFileSync(
  path.join(__dirname, "../supabase/migrations/0014_require_one_admin.sql"),
  "utf8",
);

describe("0014_require_one_admin.sql", () => {
  it("found the migration file to check (guards against a rotted path)", () => {
    expect(SQL.length).toBeGreaterThan(0);
  });

  it("declares the guard function security definer with an empty search_path, matching 0007's convention", () => {
    const m = SQL.match(/create or replace function public\.require_one_admin\(\)[\s\S]*?\$\$;/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/security definer/);
    expect(m![0]).toMatch(/set search_path = ''/);
    // Every table reference inside the function body must be schema-qualified
    // -- an unqualified `user_roles` could resolve to an object a
    // lower-privileged caller created to shadow it, under an empty search_path.
    expect(m![0]).toContain("public.user_roles");
  });

  it("raises when no admin row would remain", () => {
    const m = SQL.match(/create or replace function public\.require_one_admin\(\)[\s\S]*?\$\$;/);
    expect(m![0]).toMatch(/not exists \(select 1 from public\.user_roles where role = 'admin' for update\)/);
    expect(m![0]).toMatch(/raise exception/);
  });

  it("locks the admin rows it reads with FOR UPDATE, closing the concurrent-demotion race", () => {
    // Finding 1 of the final review: a plain SELECT under READ COMMITTED
    // takes no row lock and reads only the latest *committed* version, so
    // two overlapping demotions could otherwise both observe an admin row
    // that the other transaction has already changed but not yet
    // committed, and both pass. FOR UPDATE forces the second trigger to
    // block on the row lock and re-evaluate against the first
    // transaction's committed result once it releases that lock.
    const m = SQL.match(/create or replace function public\.require_one_admin\(\)[\s\S]*?\$\$;/);
    expect(m![0]).toMatch(/for update/);
  });

  it("is re-runnable: drops the trigger before recreating it, and replaces rather than merely creates the function", () => {
    expect(SQL).toContain("create or replace function public.require_one_admin()");
    expect(SQL).toContain("drop trigger if exists user_roles_require_one_admin on public.user_roles;");
    const dropIndex = SQL.indexOf("drop trigger if exists user_roles_require_one_admin");
    const createIndex = SQL.indexOf("create trigger user_roles_require_one_admin");
    expect(dropIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(dropIndex);
  });

  it("is row-level, not statement-level -- statement-level would still fire on a zero-row upsert", () => {
    // repo.setRole (src/services/users/repo.ts) writes every role change via
    // `.upsert(..., { onConflict: "user_id" })`, i.e.
    // `insert ... on conflict (user_id) do update ...`. Postgres has fired
    // statement-level AFTER UPDATE triggers for that statement shape since
    // 9.5 (a statement-level trigger's firing is governed by which events
    // the statement's command could invoke, not by which branch, if any, a
    // row actually took) -- so that is not why row-level is the right
    // choice. The reason is that a statement-level trigger fires
    // unconditionally once per statement even when the DO UPDATE branch
    // changes zero rows, evaluating this invariant on a write that never
    // actually changed anyone's role. Row-level AFTER UPDATE triggers fire
    // only for rows genuinely taking the DO UPDATE branch -- documented
    // Postgres behaviour for ON CONFLICT DO UPDATE -- so this only ever
    // runs the check when a role change really happened.
    const m = SQL.match(/create trigger user_roles_require_one_admin[\s\S]*?;/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/for each row/);
    expect(m![0]).not.toMatch(/for each statement/);
  });

  it("fires on UPDATE and DELETE, but never on INSERT", () => {
    // The header explains why: INSERT can only ever add a row, so it can
    // never be the operation that takes the admin count to zero, and
    // guarding it would wrongly refuse a fresh environment's very first
    // role grant (scripts/bootstrap-admin.ts), made before any admin
    // exists yet.
    const m = SQL.match(/create trigger user_roles_require_one_admin[\s\S]*?;/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/after update or delete on public\.user_roles/);
    expect(m![0]).not.toMatch(/insert/i);
  });

  it("revokes execute from public/anon/authenticated, matching 0007's convention -- nothing ever calls this directly", () => {
    expect(SQL).toContain(
      "revoke all on function public.require_one_admin() from public, anon, authenticated;",
    );
  });
});
