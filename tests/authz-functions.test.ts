import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SQL = readFileSync("supabase/migrations/0007_rbac_functions.sql", "utf8");
const FUNCS = ["authorize", "authorize_for_user", "has_site_access", "has_site_access_for_user"];

describe("authorization functions", () => {
  it("defines all four", () => {
    for (const f of FUNCS) {
      expect(SQL).toMatch(new RegExp(`create or replace function public\\.${f}\\(`));
    }
  });

  it("pins search_path on every security definer function", () => {
    // Without this a lower-privileged caller can shadow an unqualified
    // identifier and change what the function resolves to.
    const definers = SQL.match(/security definer/g) ?? [];
    const pinned = SQL.match(/set search_path = ''/g) ?? [];
    expect(definers.length).toBeGreaterThan(0);
    expect(pinned.length).toBe(definers.length);
  });

  it("schema-qualifies every table reference", () => {
    for (const t of ["user_roles", "role_permissions", "user_permission_overrides", "user_site_access"]) {
      const bare = new RegExp(`from\\s+${t}\\b`, "g");
      expect(SQL.match(bare)).toBeNull();
      expect(SQL).toMatch(new RegExp(`public\\.${t}\\b`));
    }
  });

  it("restricts the _for_user variants to service_role", () => {
    for (const f of ["authorize_for_user", "has_site_access_for_user"]) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${f}[\\s\\S]*?from`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${f}[\\s\\S]*?to service_role`));
    }
  });

  it("lets an override deny a permission the role grants", () => {
    // The override must be consulted BEFORE role_permissions, or a deny is
    // silently ignored for any permission the role already allows.
    const body = SQL.slice(SQL.indexOf("function public.authorize("));
    expect(body.indexOf("user_permission_overrides")).toBeLessThan(body.indexOf("role_permissions"));
  });
});
