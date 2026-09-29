import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SQL = readFileSync(
  new URL("../supabase/migrations/0028_rbac_write_guards.sql", import.meta.url), "utf8",
).replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("0028 RBAC write guards at the RLS layer", () => {
  it("limits matrix and override writes to admins", () => {
    for (const t of ["role_permissions", "user_permission_overrides"]) {
      expect(SQL).toMatch(new RegExp(`create policy ${t}_manage on ${t} for all to authenticated using \\( \\(select authorize\\('users.manage'\\)\\) and \\(select current_user_is_admin\\(\\)\\) \\)`));
    }
  });

  it("forbids writing your own role row and minting admins unless admin", () => {
    expect(SQL).toContain("user_id <> (select auth.uid())");
    expect(SQL).toContain("(role <> 'admin' or (select current_user_is_admin()))");
  });

  it("checks admin through a SECURITY DEFINER helper so the policy cannot recurse", () => {
    expect(SQL).toMatch(/function public\.current_user_is_admin\(\) returns boolean language sql stable security definer set search_path = public/);
    expect(SQL).toContain("revoke execute on function public.current_user_is_admin() from public, anon");
  });
});
