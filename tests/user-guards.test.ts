import { describe, expect, it } from "vitest";
import { canChangeRole, canDeleteUser, canGrantSiteAccess, canSetRolePermission } from "@/services/users/guards";
import type { ManagedUser } from "@/services/users/types";
import type { AppRole } from "@/lib/authz/types";

const user = (id: string, role: AppRole | null): ManagedUser => ({
  id, email: `${id}@example.com`, role,
  lastSignInAt: null, invitedNotAccepted: false, siteGrants: 0,
});

const ONE_ADMIN = [user("a1", "admin"), user("d1", "developer")];
const TWO_ADMINS = [user("a1", "admin"), user("a2", "admin"), user("d1", "developer")];
// Same admin id appears twice, e.g. from a join fan-out upstream. There is
// still only one distinct administrator, so the last-admin rule must fire.
const DUPLICATED_ADMIN_ROW = [user("a1", "admin"), user("a1", "admin"), user("d1", "developer")];

describe("canChangeRole", () => {
  it("refuses demoting the last admin", () => {
    const v = canChangeRole(ONE_ADMIN, "a1", "developer");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/last admin/i);
  });

  it("allows demoting yourself when another admin exists", () => {
    expect(canChangeRole(TWO_ADMINS, "a1", "developer")).toEqual({ allowed: true });
  });

  it("allows demoting another admin when one remains", () => {
    expect(canChangeRole(TWO_ADMINS, "a2", "client")).toEqual({ allowed: true });
  });

  it("allows promoting someone to admin", () => {
    expect(canChangeRole(ONE_ADMIN, "d1", "admin")).toEqual({ allowed: true });
  });

  it("refuses a target that is not in the list", () => {
    expect(canChangeRole(ONE_ADMIN, "ghost", "admin").allowed).toBe(false);
  });

  it("is a no-op verdict when the role is unchanged", () => {
    // Changing admin -> admin must not trip the last-admin rule.
    expect(canChangeRole(ONE_ADMIN, "a1", "admin")).toEqual({ allowed: true });
  });

  it("refuses demoting the last admin even when their row is duplicated in the list", () => {
    // A naive `admins.length <= 1` would see 2 rows for one person and wrongly allow this.
    const v = canChangeRole(DUPLICATED_ADMIN_ROW, "a1", "developer");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/last admin/i);
  });
});

describe("canDeleteUser", () => {
  it("refuses deleting yourself, even with other admins around", () => {
    const v = canDeleteUser(TWO_ADMINS, "a1", "a1");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/your own.*ask another admin/i);
  });

  it("refuses deleting the last admin", () => {
    const v = canDeleteUser(ONE_ADMIN, "d1", "a1");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/last admin/i);
  });

  it("refuses deleting the last admin even when their row is duplicated in the list", () => {
    // A naive `admins.length <= 1` would see 2 rows for one person and wrongly allow this.
    const v = canDeleteUser(DUPLICATED_ADMIN_ROW, "d1", "a1");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/last admin/i);
  });

  it("allows deleting a non-admin", () => {
    expect(canDeleteUser(ONE_ADMIN, "a1", "d1")).toEqual({ allowed: true });
  });

  it("refuses a target that is not in the list", () => {
    expect(canDeleteUser(ONE_ADMIN, "a1", "ghost").allowed).toBe(false);
  });

  it("allows deleting an account that has no role at all", () => {
    // A user can exist in auth.users with no user_roles row. They are denied
    // everything and are never the last admin, so removing them is always safe.
    const withRoleless = [...ONE_ADMIN, user("r1", null)];
    expect(canDeleteUser(withRoleless, "a1", "r1")).toEqual({ allowed: true });
  });
});

describe("canGrantSiteAccess", () => {
  // Finding 1 of the final whole-branch review: a `manage` grant on a
  // `client` (an external customer) is a live PHP-execution hole via
  // refreshInventoryAction, not a theoretical one -- see the reasoning in
  // src/services/users/guards.ts above canGrantSiteAccess itself.

  it("refuses a manage-level grant onto a client", () => {
    const v = canGrantSiteAccess("client", "manage");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/read access/i);
  });

  it("allows a read-level grant onto a client", () => {
    expect(canGrantSiteAccess("client", "read")).toEqual({ allowed: true });
  });

  it("allows a manage-level grant onto every staff role", () => {
    // Staff already reach every site through sites.view_all, so a grant on
    // one of them is inert either way -- but the guard must not refuse it,
    // since site-grants.tsx still lists/removes leftover grants for staff.
    expect(canGrantSiteAccess("admin", "manage")).toEqual({ allowed: true });
    expect(canGrantSiteAccess("developer", "manage")).toEqual({ allowed: true });
    expect(canGrantSiteAccess("content_writer", "manage")).toEqual({ allowed: true });
  });

  it("allows a manage-level grant onto an account with no role yet", () => {
    // Not yet a client, and may never become one -- see site-grants.tsx's
    // file header. The UI still shows a warning at the point of choosing,
    // but the server-side guard does not refuse it the way it does for an
    // actual client.
    expect(canGrantSiteAccess(null, "manage")).toEqual({ allowed: true });
  });
});

describe("canSetRolePermission", () => {
  it("refuses removing users.manage from admin", () => {
    // This is the one that makes the matrix editor unable to repair itself.
    const v = canSetRolePermission("admin", "users.manage", false);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/repair|lock/i);
  });

  it("allows granting users.manage to admin", () => {
    expect(canSetRolePermission("admin", "users.manage", true)).toEqual({ allowed: true });
  });

  it("allows removing users.manage from a non-admin role", () => {
    expect(canSetRolePermission("developer", "users.manage", false)).toEqual({ allowed: true });
  });

  it("allows removing any other permission from admin", () => {
    expect(canSetRolePermission("admin", "seo.run", false)).toEqual({ allowed: true });
  });
});
