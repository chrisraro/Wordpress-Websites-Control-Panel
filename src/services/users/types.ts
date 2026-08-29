import type { AppPermission, AppRole, SiteAccessLevel } from "@/lib/authz/types";

/**
 * One row of the user directory. `role` is nullable because an account can
 * exist in `auth.users` with no `user_roles` row — Phase 9a's `getViewer`
 * denies such a user everything, and the directory surfaces that state
 * rather than hiding it. A null-role user is never the last admin.
 */
export interface ManagedUser {
  id: string;
  email: string | null;
  role: AppRole | null;
  lastSignInAt: string | null;
  invitedNotAccepted: boolean;
  siteGrants: number;
}

/**
 * The result of a lockout guard. `reason` is rendered verbatim to an
 * administrator, so it is always a complete, plain sentence.
 */
export type GuardVerdict = { allowed: true } | { allowed: false; reason: string };

export const ALLOWED: GuardVerdict = { allowed: true };
export const refuse = (reason: string): GuardVerdict => ({ allowed: false, reason });

/**
 * One `user_site_access` row for a single user. `siteName` travels with the
 * grant (joined at the repo) rather than being looked up separately by every
 * caller — see canChangeRole's manage-grant refusal in guards.ts, which
 * would otherwise have no way to name the site in the message it renders to
 * an admin who is already looking at names, not ids, everywhere else on the
 * page. Falls back to the id only if the joined site row is ever missing
 * (a grant can in theory outlive its site only in the gap between a delete
 * and the cascade, never in steady state).
 */
export interface SiteGrant {
  siteId: string;
  siteName: string;
  accessLevel: SiteAccessLevel;
}

/** One `role_permissions` row: `permission` is enabled for `role`. */
export interface RolePermissionRow {
  role: AppRole;
  permission: AppPermission;
}
