import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseUsersRepo } from "@/services/users/repo";
import type { UsersRepo } from "@/services/users/repo";
import {
  changeUserRole,
  deleteManagedUser,
  grantSiteAccess,
  setRolePermissionChecked,
} from "@/services/users/service";
import type { ManagedUser, SiteGrant } from "@/services/users/types";

/**
 * A fake shaped like a supabase-js client: `auth.admin.*` for the auth admin
 * API, and `from(table)` returning a chainable, thenable query builder — the
 * same style as tests/authz-server.test.ts's fakeDb, extended with upsert and
 * delete so the write paths (setRole, grantSite, ...) are exercised too.
 */
type Row = Record<string, unknown>;
type AdminUser = { id: string; email?: string; last_sign_in_at?: string; action_link?: string };

const CONFLICT_KEYS: Record<string, string[]> = {
  user_roles: ["user_id"],
  user_site_access: ["user_id", "site_id"],
  role_permissions: ["role", "permission"],
};

function fakeDb(opts: {
  authUsersPages?: AdminUser[][];
  userRoles?: Row[];
  userSiteAccess?: Row[];
  rolePermissions?: Row[];
  inviteResult?: {
    data: { user: AdminUser | null; properties?: { action_link?: string } };
    error: { message: string } | null;
  };
  // Forces getUserById to fail as a genuine error (not "no such user") —
  // e.g. a network blip or an auth-admin outage — regardless of whether the
  // id matches a known user.
  getUserByIdError?: { message: string; status?: number; code?: string };
}) {
  const state: Record<string, Row[]> = {
    user_roles: [...(opts.userRoles ?? [])],
    user_site_access: [...(opts.userSiteAccess ?? [])],
    role_permissions: [...(opts.rolePermissions ?? [])],
  };
  const calls = {
    listUsersPages: [] as number[],
    deleteUser: [] as string[],
    invite: [] as { email: string; opts: unknown }[],
  };

  function builder(table: string) {
    const filters: [string, unknown][] = [];
    let isDelete = false;
    const api = {
      select() {
        return api;
      },
      eq(k: string, v: unknown) {
        filters.push([k, v]);
        return api;
      },
      delete() {
        isDelete = true;
        return api;
      },
      upsert(row: Row) {
        const keyCols = CONFLICT_KEYS[table] ?? [];
        state[table] = state[table].filter((r) => !keyCols.every((k) => r[k] === row[k]));
        state[table] = [...state[table], row];
        return Promise.resolve({ error: null });
      },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        let result: unknown;
        if (isDelete) {
          state[table] = state[table].filter(
            (r) => !filters.every(([k, v]) => r[k] === v),
          );
          result = { error: null };
        } else {
          let rows = state[table];
          for (const [k, v] of filters) rows = rows.filter((r) => r[k] === v);
          result = { data: rows, error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return api;
  }

  const pages = opts.authUsersPages ?? [[]];
  const db = {
    auth: {
      admin: {
        async listUsers({ page }: { page: number; perPage: number }) {
          calls.listUsersPages.push(page);
          const users = pages[page - 1] ?? [];
          return { data: { users, aud: "authenticated" }, error: null };
        },
        async getUserById(id: string) {
          if (opts.getUserByIdError) {
            return { data: { user: null }, error: opts.getUserByIdError };
          }
          const u = pages.flat().find((u) => u.id === id);
          if (!u) {
            // Real GoTrue reports a well-formed uuid matching no user as an
            // error with a stable `user_not_found` code — not a plain
            // `{ data: { user: null }, error: null }` — so the fake must
            // mirror that shape for the repo's error-vs-absence logic to be
            // exercised honestly.
            return {
              data: { user: null },
              error: { message: "User not found", status: 404, code: "user_not_found" },
            };
          }
          return { data: { user: u }, error: null };
        },
        async deleteUser(id: string) {
          calls.deleteUser.push(id);
          return { data: {}, error: null };
        },
        async generateLink(params: { type: string; email: string; options?: unknown }) {
          calls.invite.push({ email: params.email, opts: params.options });
          return (
            opts.inviteResult ?? {
              data: { user: { id: "new-user-id", email: params.email }, properties: {} },
              error: null,
            }
          );
        },
      },
    },
    from(table: string) {
      return builder(table);
    },
  } as unknown as SupabaseClient;

  return { db, state, calls };
}

describe("supabaseUsersRepo — listUsers composition", () => {
  it("lists a user with no user_roles row, with role: null", async () => {
    const { db } = fakeDb({
      authUsersPages: [[{ id: "u1", email: "u1@example.com", last_sign_in_at: "2026-01-01T00:00:00Z" }]],
      userRoles: [],
    });
    const repo = supabaseUsersRepo(db);
    const users = await repo.listUsers();
    expect(users).toEqual([
      {
        id: "u1",
        email: "u1@example.com",
        role: null,
        lastSignInAt: "2026-01-01T00:00:00Z",
        invitedNotAccepted: false,
        siteGrants: 0,
      },
    ]);
  });

  it("attaches the role from user_roles when a row exists", async () => {
    const { db } = fakeDb({
      authUsersPages: [[{ id: "u1", email: "u1@example.com", last_sign_in_at: "2026-01-01T00:00:00Z" }]],
      userRoles: [{ user_id: "u1", role: "admin" }],
    });
    const repo = supabaseUsersRepo(db);
    const users = await repo.listUsers();
    expect(users[0].role).toBe("admin");
  });

  it("counts site grants per user", async () => {
    const { db } = fakeDb({
      authUsersPages: [
        [
          { id: "u1", email: "u1@example.com", last_sign_in_at: "2026-01-01T00:00:00Z" },
          { id: "u2", email: "u2@example.com", last_sign_in_at: "2026-01-01T00:00:00Z" },
        ],
      ],
      userSiteAccess: [
        { user_id: "u1", site_id: "s1", access_level: "read" },
        { user_id: "u1", site_id: "s2", access_level: "manage" },
        { user_id: "u2", site_id: "s1", access_level: "read" },
      ],
    });
    const repo = supabaseUsersRepo(db);
    const users = await repo.listUsers();
    const byId = new Map(users.map((u) => [u.id, u]));
    expect(byId.get("u1")?.siteGrants).toBe(2);
    expect(byId.get("u2")?.siteGrants).toBe(1);
  });

  it("marks invitedNotAccepted when last_sign_in_at is null", async () => {
    const { db } = fakeDb({
      authUsersPages: [[{ id: "u1", email: "u1@example.com" }]],
    });
    const repo = supabaseUsersRepo(db);
    const users = await repo.listUsers();
    expect(users[0].invitedNotAccepted).toBe(true);
    expect(users[0].lastSignInAt).toBeNull();
  });

  it("pages past the default 50-per-page limit instead of silently stopping", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`,
      email: `u${i}@example.com`,
      last_sign_in_at: "2026-01-01T00:00:00Z",
    }));
    const page2 = [{ id: "u50", email: "u50@example.com", last_sign_in_at: "2026-01-01T00:00:00Z" }];
    const { db, calls } = fakeDb({ authUsersPages: [page1, page2] });
    const repo = supabaseUsersRepo(db);
    const users = await repo.listUsers();
    expect(users).toHaveLength(51);
    expect(users.map((u) => u.id)).toContain("u50");
    expect(calls.listUsersPages).toEqual([1, 2]);
  });

  it("stops after a single short page", async () => {
    const { db, calls } = fakeDb({
      authUsersPages: [[{ id: "u1", email: "u1@example.com", last_sign_in_at: "2026-01-01T00:00:00Z" }]],
    });
    const repo = supabaseUsersRepo(db);
    await repo.listUsers();
    expect(calls.listUsersPages).toEqual([1]);
  });

  it("fetches a second, empty page when the first page comes back exactly full (the 50 boundary)", async () => {
    // 50 is AUTH_USERS_PER_PAGE. A page that comes back exactly full is
    // indistinguishable from "there might be more" until a second request
    // confirms it's empty — the off-by-one this loop must not make.
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`,
      email: `u${i}@example.com`,
      last_sign_in_at: "2026-01-01T00:00:00Z",
    }));
    const { db, calls } = fakeDb({ authUsersPages: [page1, []] });
    const repo = supabaseUsersRepo(db);
    const users = await repo.listUsers();
    expect(users).toHaveLength(50);
    expect(calls.listUsersPages).toEqual([1, 2]);
  });
});

describe("supabaseUsersRepo — getUser", () => {
  it("returns the ManagedUser shape for a successful single-user lookup", async () => {
    const { db } = fakeDb({
      authUsersPages: [[{ id: "u1", email: "u1@example.com", last_sign_in_at: "2026-01-01T00:00:00Z" }]],
      userRoles: [{ user_id: "u1", role: "admin" }],
      userSiteAccess: [{ user_id: "u1", site_id: "s1", access_level: "read" }],
    });
    const repo = supabaseUsersRepo(db);
    const user = await repo.getUser("u1");
    expect(user).toEqual({
      id: "u1",
      email: "u1@example.com",
      role: "admin",
      lastSignInAt: "2026-01-01T00:00:00Z",
      invitedNotAccepted: false,
      siteGrants: 1,
    });
  });

  it("returns null for a genuinely missing user (well-formed id, no match)", async () => {
    const { db } = fakeDb({
      authUsersPages: [[{ id: "u1", email: "u1@example.com", last_sign_in_at: "2026-01-01T00:00:00Z" }]],
    });
    const repo = supabaseUsersRepo(db);
    const user = await repo.getUser("does-not-exist");
    expect(user).toBeNull();
  });

  it("throws on a genuine error instead of reporting it as null — a transient failure must not read as a deleted account", async () => {
    const { db } = fakeDb({
      authUsersPages: [[{ id: "u1", email: "u1@example.com", last_sign_in_at: "2026-01-01T00:00:00Z" }]],
      getUserByIdError: { message: "service unavailable", status: 500, code: "unexpected_failure" },
    });
    const repo = supabaseUsersRepo(db);
    await expect(repo.getUser("u1")).rejects.toThrow(/service unavailable/);
  });
});

describe("supabaseUsersRepo — writes", () => {
  it("setRole upserts into user_roles keyed on user_id", async () => {
    const { db, state } = fakeDb({});
    const repo = supabaseUsersRepo(db);
    await repo.setRole("u1", "developer", "actor-1");
    expect(state.user_roles).toEqual([
      { user_id: "u1", role: "developer", granted_by: "actor-1" },
    ]);
  });

  it("deleteUser calls the auth admin API", async () => {
    const { db, calls } = fakeDb({});
    const repo = supabaseUsersRepo(db);
    await repo.deleteUser("u1");
    expect(calls.deleteUser).toEqual(["u1"]);
  });

  it("listGrants returns this user's site grants only", async () => {
    const { db } = fakeDb({
      userSiteAccess: [
        { user_id: "u1", site_id: "s1", access_level: "read" },
        { user_id: "u2", site_id: "s2", access_level: "manage" },
      ],
    });
    const repo = supabaseUsersRepo(db);
    const grants = await repo.listGrants("u1");
    // The fake query builder does not simulate the `sites(name)` join, so
    // this exercises the same "joined row missing" fallback the real repo
    // uses when a grant briefly outlives its site.
    expect(grants).toEqual([{ siteId: "s1", siteName: "s1", accessLevel: "read" }]);
  });

  it("grantSite upserts a user_site_access row", async () => {
    const { db, state } = fakeDb({});
    const repo = supabaseUsersRepo(db);
    await repo.grantSite("u1", "s1", "manage", "actor-1");
    expect(state.user_site_access).toEqual([
      { user_id: "u1", site_id: "s1", access_level: "manage", granted_by: "actor-1" },
    ]);
  });

  it("revokeSite deletes the matching user_site_access row", async () => {
    const { db, state } = fakeDb({
      userSiteAccess: [
        { user_id: "u1", site_id: "s1", access_level: "read" },
        { user_id: "u1", site_id: "s2", access_level: "read" },
      ],
    });
    const repo = supabaseUsersRepo(db);
    await repo.revokeSite("u1", "s1");
    expect(state.user_site_access).toEqual([{ user_id: "u1", site_id: "s2", access_level: "read" }]);
  });

  it("listRolePermissions returns the whole matrix", async () => {
    const { db } = fakeDb({
      rolePermissions: [{ role: "admin", permission: "users.manage" }],
    });
    const repo = supabaseUsersRepo(db);
    expect(await repo.listRolePermissions()).toEqual([{ role: "admin", permission: "users.manage" }]);
  });

  it("setRolePermission(enabled: true) upserts the row", async () => {
    const { db, state } = fakeDb({});
    const repo = supabaseUsersRepo(db);
    await repo.setRolePermission("developer", "seo.run", true);
    expect(state.role_permissions).toEqual([{ role: "developer", permission: "seo.run" }]);
  });

  it("setRolePermission(enabled: false) deletes the row", async () => {
    const { db, state } = fakeDb({
      rolePermissions: [{ role: "developer", permission: "seo.run" }],
    });
    const repo = supabaseUsersRepo(db);
    await repo.setRolePermission("developer", "seo.run", false);
    expect(state.role_permissions).toEqual([]);
  });

  it("inviteUser returns the action link when Supabase provides one", async () => {
    const { db } = fakeDb({
      inviteResult: {
        data: {
          user: { id: "new-user", email: "new@example.com" },
          properties: { action_link: "https://example.com/verify?token=abc" },
        },
        error: null,
      },
    });
    const repo = supabaseUsersRepo(db);
    const result = await repo.inviteUser("new@example.com", "https://app.example.com/login");
    expect(result).toEqual({ id: "new-user", inviteLink: "https://example.com/verify?token=abc" });
  });

  it("inviteUser returns inviteLink: null when Supabase does not provide an action_link", async () => {
    const { db } = fakeDb({
      inviteResult: {
        data: { user: { id: "new-user", email: "new@example.com" }, properties: {} },
        error: null,
      },
    });
    const repo = supabaseUsersRepo(db);
    const result = await repo.inviteUser("new@example.com", "https://app.example.com/login");
    expect(result).toEqual({ id: "new-user", inviteLink: null });
  });

  it("inviteUser throws when Supabase returns an error", async () => {
    const { db } = fakeDb({
      inviteResult: { data: { user: null }, error: { message: "rate limited" } },
    });
    const repo = supabaseUsersRepo(db);
    await expect(repo.inviteUser("new@example.com", "https://app.example.com/login")).rejects.toThrow(
      /rate limited/,
    );
  });
});

/** In-memory UsersRepo fake for the service layer — see tests/bulk-service.test.ts. */
function memoryUsersRepo(initialUsers: ManagedUser[], initialGrants: Record<string, SiteGrant[]> = {}) {
  let users = [...initialUsers];
  const grantsByUserId = new Map<string, SiteGrant[]>(
    Object.entries(initialGrants).map(([id, grants]) => [id, [...grants]]),
  );
  const setRoleCalls: { userId: string; role: string; grantedBy: string }[] = [];
  const deleteCalls: string[] = [];
  const setRolePermissionCalls: { role: string; permission: string; enabled: boolean }[] = [];
  const grantSiteCalls: { userId: string; siteId: string; level: string; grantedBy: string }[] = [];
  const listGrantsCalls: string[] = [];

  const repo: UsersRepo = {
    async listUsers() {
      return users;
    },
    async getUser(id) {
      return users.find((u) => u.id === id) ?? null;
    },
    async setRole(userId, role, grantedBy) {
      setRoleCalls.push({ userId, role, grantedBy });
      users = users.map((u) => (u.id === userId ? { ...u, role } : u));
    },
    async deleteUser(id) {
      deleteCalls.push(id);
      users = users.filter((u) => u.id !== id);
    },
    async listGrants(userId) {
      listGrantsCalls.push(userId);
      return grantsByUserId.get(userId) ?? [];
    },
    async grantSite(userId, siteId, level, grantedBy) {
      grantSiteCalls.push({ userId, siteId, level, grantedBy });
      const existing = grantsByUserId.get(userId) ?? [];
      grantsByUserId.set(userId, [
        ...existing.filter((g) => g.siteId !== siteId),
        { siteId, siteName: siteId, accessLevel: level },
      ]);
    },
    async revokeSite(userId, siteId) {
      const existing = grantsByUserId.get(userId) ?? [];
      grantsByUserId.set(
        userId,
        existing.filter((g) => g.siteId !== siteId),
      );
    },
    async listRolePermissions() {
      return [];
    },
    async setRolePermission(role, permission, enabled) {
      setRolePermissionCalls.push({ role, permission, enabled });
    },
    async inviteUser(email) {
      return { id: `invited-${email}`, inviteLink: null };
    },
  };
  return {
    repo,
    setRoleCalls,
    deleteCalls,
    setRolePermissionCalls,
    grantSiteCalls,
    listGrantsCalls,
    getUsers: () => users,
  };
}

const managedUser = (id: string, role: ManagedUser["role"]): ManagedUser => ({
  id,
  email: `${id}@example.com`,
  role,
  lastSignInAt: null,
  invitedNotAccepted: false,
  siteGrants: 0,
});

describe("changeUserRole", () => {
  it("applies the guard's refusal instead of writing when demoting the last admin", async () => {
    const { repo, setRoleCalls } = memoryUsersRepo([managedUser("a1", "admin")]);
    const result = await changeUserRole(repo, "a1", "a1", "developer");
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/last admin/i) });
    expect(setRoleCalls).toHaveLength(0);
  });

  it("writes the new role when the guard allows it", async () => {
    const { repo, setRoleCalls } = memoryUsersRepo([
      managedUser("a1", "admin"),
      managedUser("a2", "admin"),
    ]);
    const result = await changeUserRole(repo, "a1", "a2", "developer");
    expect(result).toEqual({ ok: true });
    expect(setRoleCalls).toEqual([{ userId: "a2", role: "developer", grantedBy: "a1" }]);
  });

  it("evaluates the guard against a freshly read list, not a stale caller-supplied one", async () => {
    // The repo's live list has two admins even though a caller might be
    // holding a stale snapshot with only one. The guard must see the fresh
    // list, so demoting a2 is allowed.
    const { repo, setRoleCalls } = memoryUsersRepo([
      managedUser("a1", "admin"),
      managedUser("a2", "admin"),
    ]);
    const result = await changeUserRole(repo, "a1", "a2", "client");
    expect(result.ok).toBe(true);
    expect(setRoleCalls).toHaveLength(1);
  });

  // Finding 4 of the final whole-branch review: changing a staff account's
  // role to `client` while it still holds a manage-level site grant would
  // re-create the exposure canGrantSiteAccess refuses at grant time.
  describe("changing role to client with an existing site grant", () => {
    it("refuses when the target holds a manage-level grant, and writes nothing", async () => {
      const { repo, setRoleCalls } = memoryUsersRepo(
        [managedUser("a1", "admin"), managedUser("a2", "admin"), managedUser("d1", "developer")],
        { d1: [{ siteId: "site-1", siteName: "Site One", accessLevel: "manage" }] },
      );
      const result = await changeUserRole(repo, "a1", "d1", "client");
      expect(result).toEqual({ ok: false, error: expect.stringMatching(/manage-level access/i) });
      expect(setRoleCalls).toHaveLength(0);
    });

    it("allows when the target holds only read-level grants", async () => {
      const { repo, setRoleCalls } = memoryUsersRepo(
        [managedUser("a1", "admin"), managedUser("a2", "admin"), managedUser("d1", "developer")],
        { d1: [{ siteId: "site-1", siteName: "Site One", accessLevel: "read" }] },
      );
      const result = await changeUserRole(repo, "a1", "d1", "client");
      expect(result).toEqual({ ok: true });
      expect(setRoleCalls).toHaveLength(1);
    });

    it("allows when the target holds no grants at all", async () => {
      const { repo, setRoleCalls } = memoryUsersRepo([
        managedUser("a1", "admin"),
        managedUser("a2", "admin"),
        managedUser("d1", "developer"),
      ]);
      const result = await changeUserRole(repo, "a1", "d1", "client");
      expect(result).toEqual({ ok: true });
      expect(setRoleCalls).toHaveLength(1);
    });

    it("allows changing to a staff role even with a manage-level grant, since it is never enforced there", async () => {
      const { repo, setRoleCalls } = memoryUsersRepo(
        [managedUser("a1", "admin"), managedUser("a2", "admin"), managedUser("d1", "developer")],
        { d1: [{ siteId: "site-1", siteName: "Site One", accessLevel: "manage" }] },
      );
      const result = await changeUserRole(repo, "a1", "d1", "content_writer");
      expect(result).toEqual({ ok: true });
      expect(setRoleCalls).toHaveLength(1);
    });

    it("reads the target's grants fresh at write time, not a stale snapshot", async () => {
      // The grant is added *after* this repo was constructed, standing in
      // for "someone granted this account manage access between render and
      // this write" -- the same freshness discipline this file already
      // exercises for the last-admin list above and for grantSiteAccess's
      // role read.
      const { repo, setRoleCalls, listGrantsCalls } = memoryUsersRepo([
        managedUser("a1", "admin"),
        managedUser("a2", "admin"),
        managedUser("d1", "developer"),
      ]);
      await repo.grantSite("d1", "site-1", "manage", "someone-else");
      const result = await changeUserRole(repo, "a1", "d1", "client");
      expect(result.ok).toBe(false);
      expect(setRoleCalls).toHaveLength(0);
      expect(listGrantsCalls).toContain("d1");
    });

    it("does not fetch grants at all for a transition that is not to client", async () => {
      const { repo, listGrantsCalls } = memoryUsersRepo([
        managedUser("a1", "admin"),
        managedUser("a2", "admin"),
        managedUser("d1", "developer"),
      ]);
      await changeUserRole(repo, "a1", "d1", "content_writer");
      expect(listGrantsCalls).toHaveLength(0);
    });
  });
});

describe("deleteManagedUser", () => {
  it("refuses deleting the last admin", async () => {
    const { repo, deleteCalls } = memoryUsersRepo([managedUser("a1", "admin"), managedUser("d1", "developer")]);
    const result = await deleteManagedUser(repo, "d1", "a1");
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/last admin/i) });
    expect(deleteCalls).toHaveLength(0);
  });

  it("refuses deleting yourself", async () => {
    const { repo, deleteCalls } = memoryUsersRepo([managedUser("a1", "admin"), managedUser("a2", "admin")]);
    const result = await deleteManagedUser(repo, "a1", "a1");
    expect(result.ok).toBe(false);
    expect(deleteCalls).toHaveLength(0);
  });

  it("deletes when the guard allows it", async () => {
    const { repo, deleteCalls } = memoryUsersRepo([managedUser("a1", "admin"), managedUser("a2", "admin")]);
    const result = await deleteManagedUser(repo, "a1", "a2");
    expect(result).toEqual({ ok: true });
    expect(deleteCalls).toEqual(["a2"]);
  });
});

describe("setRolePermissionChecked", () => {
  it("refuses stripping users.manage from admin", async () => {
    const { repo, setRolePermissionCalls } = memoryUsersRepo([]);
    const result = await setRolePermissionChecked(repo, "admin", "users.manage", false);
    expect(result.ok).toBe(false);
    expect(setRolePermissionCalls).toHaveLength(0);
  });

  it("writes when the guard allows it", async () => {
    const { repo, setRolePermissionCalls } = memoryUsersRepo([]);
    const result = await setRolePermissionChecked(repo, "developer", "seo.run", false);
    expect(result).toEqual({ ok: true });
    expect(setRolePermissionCalls).toEqual([{ role: "developer", permission: "seo.run", enabled: false }]);
  });
});

describe("grantSiteAccess", () => {
  it("allows a manage-level grant onto a staff role", async () => {
    const { repo, grantSiteCalls } = memoryUsersRepo([managedUser("u1", "developer")]);
    const result = await grantSiteAccess(repo, "u1", "site-1", "manage", "actor-1");
    expect(result).toEqual({ ok: true });
    expect(grantSiteCalls).toEqual([
      { userId: "u1", siteId: "site-1", level: "manage", grantedBy: "actor-1" },
    ]);
  });

  it("allows a read-level grant onto a client", async () => {
    const { repo, grantSiteCalls } = memoryUsersRepo([managedUser("u1", "client")]);
    const result = await grantSiteAccess(repo, "u1", "site-1", "read", "actor-1");
    expect(result).toEqual({ ok: true });
    expect(grantSiteCalls).toHaveLength(1);
  });

  it("refuses a manage-level grant onto a client, reading the role from the repo rather than trusting the caller", async () => {
    const { repo, grantSiteCalls } = memoryUsersRepo([managedUser("u1", "client")]);
    const result = await grantSiteAccess(repo, "u1", "site-1", "manage", "actor-1");
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/read access/i) });
    expect(grantSiteCalls).toHaveLength(0);
  });

  it("refuses a manage-level grant when the target's role changed to client after the page that offered this write rendered", async () => {
    // Same freshly-read discipline this file already exercises for
    // changeUserRole above: the guard here must not trust a role the
    // caller derived earlier (e.g. from a page render) -- it must see
    // whatever the repo says *right now*. Simulated by writing the role
    // change directly through the fake repo, standing in for "someone
    // else changed this account's role between render and this write",
    // then calling grantSiteAccess with no role of its own to trust.
    const { repo, grantSiteCalls } = memoryUsersRepo([managedUser("u1", "developer")]);
    await repo.setRole("u1", "client", "someone-else");
    const result = await grantSiteAccess(repo, "u1", "site-1", "manage", "actor-1");
    expect(result.ok).toBe(false);
    expect(grantSiteCalls).toHaveLength(0);
  });
});
