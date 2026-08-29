import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UsersRepo } from "@/services/users/repo";
import type { ManagedUser } from "@/services/users/types";

// Every exported function in src/app/(dashboard)/users/actions.ts is a
// "use server" action, which means it is a publicly invokable HTTP endpoint
// whether or not any page in this app calls it. Before this task none of
// them existed; this file pins that all six start with the same guard —
// requireUser() then checkPermission("users.manage") — and are refused
// without it, exactly like tests/authz-actions-toolkit.test.ts does for the
// sites/wp_toolkit actions.
//
// Unlike that file, three of these actions (setUserRoleAction,
// deleteUserAction, setRolePermissionAction) must also exercise the *real*
// lockout guards from src/services/users/guards.ts — demoting the last
// admin, deleting yourself, stripping users.manage from admin — so
// @/services/users/service is left un-mocked here. The boundary that must
// not be reached when a guard (permission or lockout) refuses is the repo:
// src/services/users/repo.ts's supabaseUsersRepo is mocked to hand back a
// fake whose write methods throw by default, so a missing or ignored guard
// fails the test loudly (an unhandled rejection) instead of quietly passing
// because nothing asserted the write never happened.

vi.mock("@/lib/supabase/server", () => ({
  requireUser: () => Promise.resolve({ id: "actor-1", email: "actor@example.com" }),
  createServiceSupabase: () => ({}) as never,
}));

// Every prior test in this file resolves to {ok:false}, which returns
// before ever reaching revalidatePath -- so nothing here needed a real
// request-scoped store until the site-grant guard tests below, which are
// the first in this file to exercise a genuine successful write.
// revalidatePath() throws outside a Next.js request context; mocked to a
// no-op the same way route handlers mock it elsewhere in this suite.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const DENIED = { ok: false, error: "You do not have permission to do that." };
const FAKE_VIEWER = {
  id: "actor-1", email: "actor@example.com", role: "admin",
  permissions: new Set(["users.manage"]), grants: new Map(),
};

const checkPermissionMock = vi.fn();
vi.mock("@/lib/authz/server", () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
  isDenied: (x: unknown): boolean =>
    typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));

let currentRepo: UsersRepo;
vi.mock("@/services/users/repo", () => ({
  supabaseUsersRepo: () => currentRepo,
}));

// Imported after the mocks above so the action module picks up the mocked
// requireUser/checkPermission/supabaseUsersRepo rather than the real ones.
// @/services/users/service is deliberately NOT mocked — the lockout-path
// tests below need its real guard logic.
import {
  inviteUserAction,
  setUserRoleAction,
  deleteUserAction,
  grantSiteAction,
  revokeSiteAction,
  setRolePermissionAction,
} from "@/app/(dashboard)/users/actions";

function formData(entries: Record<string, string | string[]> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) for (const item of v) fd.append(k, item);
    else fd.set(k, v);
  }
  return fd;
}

const managedUser = (id: string, role: ManagedUser["role"]): ManagedUser => ({
  id,
  email: `${id}@example.com`,
  role,
  lastSignInAt: "2026-01-01T00:00:00Z",
  invitedNotAccepted: false,
  siteGrants: 0,
});

/** A UsersRepo fake whose methods throw unless overridden — see file header. */
function fakeRepo(overrides: Partial<{ [K in keyof UsersRepo]: UsersRepo[K] }> = {}): UsersRepo {
  const notCalled = <K extends keyof UsersRepo>(name: K) =>
    vi.fn(async () => {
      throw new Error(`${name} must not be called when denied`);
    }) as unknown as UsersRepo[K];
  return {
    listUsers: overrides.listUsers ?? notCalled("listUsers"),
    getUser: overrides.getUser ?? notCalled("getUser"),
    setRole: overrides.setRole ?? notCalled("setRole"),
    deleteUser: overrides.deleteUser ?? notCalled("deleteUser"),
    listGrants: overrides.listGrants ?? notCalled("listGrants"),
    grantSite: overrides.grantSite ?? notCalled("grantSite"),
    revokeSite: overrides.revokeSite ?? notCalled("revokeSite"),
    listRolePermissions: overrides.listRolePermissions ?? notCalled("listRolePermissions"),
    setRolePermission: overrides.setRolePermission ?? notCalled("setRolePermission"),
    inviteUser: overrides.inviteUser ?? notCalled("inviteUser"),
  };
}

beforeEach(() => {
  checkPermissionMock.mockReset();
  currentRepo = fakeRepo();
});

describe("permission gate — every action refuses without users.manage", () => {
  it("inviteUserAction", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await inviteUserAction(undefined, formData({ email: "new@example.com", role: "developer" }));
    expect(result).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("users.manage");
  });

  it("setUserRoleAction", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await setUserRoleAction("u2", "developer", undefined, formData());
    expect(result).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("users.manage");
  });

  it("deleteUserAction", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await deleteUserAction("u2", undefined, formData());
    expect(result).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("users.manage");
  });

  it("grantSiteAction", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await grantSiteAction("u2", "site-1", "read", undefined, formData());
    expect(result).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("users.manage");
  });

  it("revokeSiteAction", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await revokeSiteAction("u2", "site-1", undefined, formData());
    expect(result).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("users.manage");
  });

  it("setRolePermissionAction", async () => {
    checkPermissionMock.mockResolvedValue(DENIED);
    const result = await setRolePermissionAction("developer", "seo.run", false, undefined, formData());
    expect(result).toEqual(DENIED);
    expect(checkPermissionMock).toHaveBeenCalledWith("users.manage");
  });
});

describe("lockout guards reach the caller as denials, not throws", () => {
  it("refuses demoting the last admin", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    const setRole = vi.fn(async () => {});
    currentRepo = fakeRepo({
      listUsers: async () => [managedUser("a1", "admin")],
      setRole,
    });
    const result = await setUserRoleAction("a1", "developer");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/last admin/i);
    expect(setRole).not.toHaveBeenCalled();
  });

  it("refuses deleting yourself", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    const deleteUser = vi.fn(async () => {});
    currentRepo = fakeRepo({
      listUsers: async () => [managedUser("actor-1", "admin"), managedUser("a2", "admin")],
      deleteUser,
    });
    const result = await deleteUserAction("actor-1");
    expect(result.ok).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("refuses unchecking users.manage for admin", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    const setRolePermission = vi.fn(async () => {});
    currentRepo = fakeRepo({ setRolePermission });
    const result = await setRolePermissionAction("admin", "users.manage", false);
    expect(result.ok).toBe(false);
    expect(setRolePermission).not.toHaveBeenCalled();
  });
});

describe("grantSiteAction — site-grant guard", () => {
  // Finding 1 of the final whole-branch review: a `manage` grant on a
  // `client` is a live PHP-execution hole via refreshInventoryAction, not
  // a theoretical one. This exercises the real canGrantSiteAccess guard
  // (service is not mocked in this file — see the header), through the
  // action a signed-in admin actually calls.
  it("refuses granting manage access to a client", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    const grantSite = vi.fn(async () => {});
    currentRepo = fakeRepo({
      getUser: async () => managedUser("u2", "client"),
      grantSite,
    });
    const result = await grantSiteAction("u2", "site-1", "manage");
    expect(result.ok).toBe(false);
    expect(grantSite).not.toHaveBeenCalled();
  });

  it("allows granting read access to a client", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    const grantSite = vi.fn(async () => {});
    currentRepo = fakeRepo({
      getUser: async () => managedUser("u2", "client"),
      grantSite,
    });
    const result = await grantSiteAction("u2", "site-1", "read");
    expect(result.ok).toBe(true);
    expect(grantSite).toHaveBeenCalledWith("u2", "site-1", "read", "actor-1");
  });

  it("allows granting manage access to a staff role", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    const grantSite = vi.fn(async () => {});
    currentRepo = fakeRepo({
      getUser: async () => managedUser("u2", "developer"),
      grantSite,
    });
    const result = await grantSiteAction("u2", "site-1", "manage");
    expect(result.ok).toBe(true);
    expect(grantSite).toHaveBeenCalledWith("u2", "site-1", "manage", "actor-1");
  });
});

describe("inviteUserAction — invite rules", () => {
  it("refuses a client invite with no site ids, without creating an account", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    const inviteUser = vi.fn(async () => ({ id: "new-user-id", inviteLink: null }));
    currentRepo = fakeRepo({ inviteUser });
    const result = await inviteUserAction(
      undefined,
      formData({ email: "new@example.com", role: "client" }),
    );
    expect(result.ok).toBe(false);
    expect(inviteUser).not.toHaveBeenCalled();
  });

  it("deletes the just-created auth user when the role insert fails", async () => {
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    const inviteUser = vi.fn(async () => ({ id: "new-user-id", inviteLink: "https://x/invite?token=abc" }));
    const setRole = vi.fn(async () => {
      throw new Error("db exploded");
    });
    const deleteUser = vi.fn(async () => {});
    currentRepo = fakeRepo({
      inviteUser,
      // The new account already shows up in the directory (role: null,
      // since the row this call is about to write hasn't landed) — exactly
      // what a real listUsers() would show immediately after invite.
      listUsers: async () => [managedUser("new-user-id", null), managedUser("actor-1", "admin")],
      setRole,
      deleteUser,
    });

    const result = await inviteUserAction(
      undefined,
      formData({ email: "new@example.com", role: "developer" }),
    );

    expect(result.ok).toBe(false);
    expect(inviteUser).toHaveBeenCalledTimes(1);
    expect(deleteUser).toHaveBeenCalledWith("new-user-id");
  });

  it("rolls back a failed invite even when the guarded delete would refuse", async () => {
    // Reproduces the trace from the Phase 9b review: changeUserRole commits
    // the new account's role to "admin" (its role was still null when the
    // guard ran, so the last-admin check did not engage), then a site grant
    // fails. By the time the rollback runs, the freshly-created account is
    // "admin" and, in this fake directory, the *only* admin — exactly the
    // state that makes the guarded deleteManagedUser refuse. The rollback
    // must use the unguarded rollbackFailedInvite instead, or a live,
    // fully-privileged admin account survives while the action claims
    // nothing was kept.
    checkPermissionMock.mockResolvedValue(FAKE_VIEWER);
    let targetRole: ManagedUser["role"] = null;
    const inviteUser = vi.fn(async () => ({ id: "new-user-id", inviteLink: "https://x/invite?token=abc" }));
    const setRole = vi.fn(async (_userId: string, role: ManagedUser["role"]) => {
      targetRole = role;
    });
    const grantSite = vi.fn(async () => {
      throw new Error("grantSite failed: foreign key violation on site_id");
    });
    const deleteUser = vi.fn(async () => {});
    currentRepo = fakeRepo({
      inviteUser,
      // Re-read on every call, the same as the real repo — so the second
      // read (inside the rollback) reflects the setRole write the first
      // read triggered. Only the invited account is present, making it the
      // sole admin the moment its role becomes "admin".
      listUsers: async () => [managedUser("new-user-id", targetRole)],
      setRole,
      grantSite,
      deleteUser,
    });

    const result = await inviteUserAction(
      undefined,
      formData({ email: "new-admin@example.com", role: "admin", siteIds: ["bad-site"] }),
    );

    expect(result.ok).toBe(false);
    // The account must actually be gone. Before the fix, the rollback went
    // through the guarded deleteManagedUser, which refused (last admin) and
    // returned {ok:false} rather than throwing, so the `.catch(() => {})`
    // around it swallowed nothing and deleteUser was never called.
    expect(deleteUser).toHaveBeenCalledWith("new-user-id");
  });
});
