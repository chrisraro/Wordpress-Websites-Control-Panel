import type { SupabaseClient, User as AuthUser } from "@supabase/supabase-js";
import type { AppPermission, AppRole, SiteAccessLevel } from "@/lib/authz/types";
import type { ManagedUser, RolePermissionRow, SiteGrant } from "./types";

/**
 * The user-management data layer. Takes the service-role client — the auth
 * admin API (`db.auth.admin.*`) requires it, and this whole surface is
 * staff-only (never reachable from a user's own session).
 */
export interface UsersRepo {
  listUsers(): Promise<ManagedUser[]>;
  getUser(id: string): Promise<ManagedUser | null>;
  /**
   * Unguarded primitive: writes the role with no lockout logic. Does not
   * check whether this would demote the last remaining admin. Every caller
   * outside this module must go through `changeUserRole` in `service.ts`,
   * which reads a fresh user list and applies that guard before calling
   * this. Call this directly and you can strip admin from every account
   * with no way back except editing `user_roles` via SQL.
   */
  setRole(userId: string, role: AppRole, grantedBy: string): Promise<void>;
  /**
   * Unguarded primitive: deletes the auth user with no lockout or
   * self-delete logic. Every caller outside this module must go through
   * `deleteManagedUser` in `service.ts`, which applies the last-admin and
   * self-delete guards before calling this. Call this directly and you can
   * delete the last remaining admin account with no way back except SQL.
   */
  deleteUser(id: string): Promise<void>;
  listGrants(userId: string): Promise<SiteGrant[]>;
  grantSite(userId: string, siteId: string, level: SiteAccessLevel, grantedBy: string): Promise<void>;
  revokeSite(userId: string, siteId: string): Promise<void>;
  listRolePermissions(): Promise<RolePermissionRow[]>;
  /**
   * Unguarded primitive: writes the role/permission row with no check that
   * this would strip `users.manage` from the admin role. Every caller
   * outside this module must go through `setRolePermissionChecked` in
   * `service.ts`, which applies that guard before calling this. Call this
   * directly and you can lock every admin out of user management with no
   * way back except SQL.
   */
  setRolePermission(role: AppRole, permission: AppPermission, enabled: boolean): Promise<void>;
  /**
   * Creates the account via `auth.admin.generateLink({ type: "invite" })`
   * (not `inviteUserByEmail`, whose returned user never carries a usable
   * action_link — measured against this project) and returns the action
   * link. No email is sent by this call, or by anything else in this
   * codebase: `generateLink` only generates the link, it does not deliver
   * it. The returned link is the *only* delivery mechanism — whoever
   * consumes it must copy/send it to the invitee themselves, not present it
   * as a fallback for a mail that is otherwise on its way. `null` when no
   * link is present; never invented. The link is a bearer credential —
   * callers must return it, never log or store it.
   */
  inviteUser(email: string, redirectTo: string): Promise<{ id: string; inviteLink: string | null }>;
}

// Supabase's default; passed explicitly so pagination never silently relies
// on a default that could change out from under us.
const AUTH_USERS_PER_PAGE = 50;

export function supabaseUsersRepo(db: SupabaseClient): UsersRepo {
  /**
   * Pages `auth.admin.listUsers` until a short page comes back — the same
   * approach as scripts/bootstrap-admin.ts. A directory that silently stops
   * at 50 accounts is a bug that only appears once you have 51.
   */
  async function listAllAuthUsers(): Promise<AuthUser[]> {
    const all: AuthUser[] = [];
    for (let page = 1; ; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: AUTH_USERS_PER_PAGE });
      if (error) throw new Error(`listUsers (auth) failed: ${error.message}`);
      all.push(...data.users);
      if (data.users.length < AUTH_USERS_PER_PAGE) break;
    }
    return all;
  }

  /** Joins auth users against `user_roles` and a per-user grant count. */
  async function toManagedUsers(authUsers: AuthUser[]): Promise<ManagedUser[]> {
    const [{ data: roleRows, error: roleErr }, { data: grantRows, error: grantErr }] = await Promise.all([
      db.from("user_roles").select("user_id,role"),
      db.from("user_site_access").select("user_id"),
    ]);
    if (roleErr) throw new Error(`listUsers (user_roles) failed: ${roleErr.message}`);
    if (grantErr) throw new Error(`listUsers (user_site_access) failed: ${grantErr.message}`);

    const roleByUserId = new Map<string, AppRole>(
      (roleRows ?? []).map((r: { user_id: string; role: AppRole }) => [r.user_id, r.role]),
    );
    const grantCountByUserId = new Map<string, number>();
    for (const g of (grantRows ?? []) as { user_id: string }[]) {
      grantCountByUserId.set(g.user_id, (grantCountByUserId.get(g.user_id) ?? 0) + 1);
    }

    return authUsers.map((u) => ({
      id: u.id,
      email: u.email ?? null,
      // No user_roles row is a real state, not an omission — Phase 9a's
      // getViewer denies such a user everything, and hiding them here would
      // make that state undiagnosable.
      role: roleByUserId.get(u.id) ?? null,
      lastSignInAt: u.last_sign_in_at ?? null,
      invitedNotAccepted: !u.last_sign_in_at,
      siteGrants: grantCountByUserId.get(u.id) ?? 0,
    }));
  }

  return {
    async listUsers() {
      const authUsers = await listAllAuthUsers();
      return toManagedUsers(authUsers);
    },

    async getUser(id) {
      const { data, error } = await db.auth.admin.getUserById(id);
      // A genuine failure (network blip, auth-admin outage, rate limit) and
      // "no such user" both come back as `error` on this same response
      // shape — they must NOT be collapsed into the same `null` return, or
      // an outage renders as "this account no longer exists" (confidently
      // wrong, worse than an error). This is the same bug shape Phase 9a
      // shipped and had to fix. GoTrue gives a real miss the stable
      // `user_not_found` code; anything else is treated as a real failure
      // and thrown, matching how every other method in this repo handles
      // `error`.
      if (error) {
        if (error.code === "user_not_found") return null;
        throw new Error(`getUser failed: ${error.message}`);
      }
      if (!data.user) return null;
      const [managed] = await toManagedUsers([data.user]);
      return managed;
    },

    async setRole(userId, role, grantedBy) {
      const { error } = await db
        .from("user_roles")
        .upsert({ user_id: userId, role, granted_by: grantedBy }, { onConflict: "user_id" });
      if (error) throw new Error(`setRole failed: ${error.message}`);
    },

    async deleteUser(id) {
      const { error } = await db.auth.admin.deleteUser(id);
      if (error) throw new Error(`deleteUser failed: ${error.message}`);
    },

    async listGrants(userId) {
      const { data, error } = await db
        .from("user_site_access")
        .select("site_id,access_level")
        .eq("user_id", userId);
      if (error) throw new Error(`listGrants failed: ${error.message}`);
      return (data ?? []).map((r: { site_id: string; access_level: SiteAccessLevel }) => ({
        siteId: r.site_id,
        accessLevel: r.access_level,
      }));
    },

    async grantSite(userId, siteId, level, grantedBy) {
      const { error } = await db.from("user_site_access").upsert(
        { user_id: userId, site_id: siteId, access_level: level, granted_by: grantedBy },
        { onConflict: "user_id,site_id" },
      );
      if (error) throw new Error(`grantSite failed: ${error.message}`);
    },

    async revokeSite(userId, siteId) {
      const { error } = await db
        .from("user_site_access")
        .delete()
        .eq("user_id", userId)
        .eq("site_id", siteId);
      if (error) throw new Error(`revokeSite failed: ${error.message}`);
    },

    async listRolePermissions() {
      const { data, error } = await db.from("role_permissions").select("role,permission");
      if (error) throw new Error(`listRolePermissions failed: ${error.message}`);
      return (data ?? []) as RolePermissionRow[];
    },

    async setRolePermission(role, permission, enabled) {
      if (enabled) {
        const { error } = await db
          .from("role_permissions")
          .upsert({ role, permission }, { onConflict: "role,permission" });
        if (error) throw new Error(`setRolePermission failed: ${error.message}`);
      } else {
        const { error } = await db
          .from("role_permissions")
          .delete()
          .eq("role", role)
          .eq("permission", permission);
        if (error) throw new Error(`setRolePermission failed: ${error.message}`);
      }
    },

    async inviteUser(email, redirectTo) {
      // generateLink({ type: "invite" }), not inviteUserByEmail: measured
      // against this project, inviteUserByEmail creates the account but
      // returns a user whose action_link is undefined, so there is no link
      // to show. generateLink creates the same account and returns
      // properties.action_link. Neither call sends an email — the returned
      // link is the only way this invite ever reaches the invitee, so the
      // API that cannot produce a link is the wrong tool regardless.
      const { data, error } = await db.auth.admin.generateLink({
        type: "invite",
        email,
        options: { redirectTo },
      });
      if (error) throw new Error(`inviteUser failed: ${error.message}`);
      return { id: data.user.id, inviteLink: data.properties.action_link ?? null };
    },
  };
}
