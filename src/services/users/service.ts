import type { AppPermission, AppRole, SiteAccessLevel } from "@/lib/authz/types";
import { canChangeRole, canDeleteUser, canSetRolePermission } from "./guards";
import type { UsersRepo } from "./repo";
import type { ManagedUser, RolePermissionRow, SiteGrant } from "./types";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** The directory, for rendering the user-management page. */
export async function listManagedUsers(repo: UsersRepo): Promise<ManagedUser[]> {
  return repo.listUsers();
}

/**
 * Changes a user's role. The lockout guard is evaluated against a *freshly
 * read* list from the repo, never against a list the caller passed in — a
 * caller-supplied list is a snapshot of what some page rendered, and
 * "is this the last admin?" answered from a stale page is exactly the check
 * that fails when it matters.
 */
export async function changeUserRole(
  repo: UsersRepo,
  actorId: string,
  targetId: string,
  next: AppRole,
): Promise<ActionResult> {
  const users = await repo.listUsers();
  const verdict = canChangeRole(users, targetId, next);
  if (!verdict.allowed) return { ok: false, error: verdict.reason };
  await repo.setRole(targetId, next, actorId);
  return { ok: true };
}

/** Deletes an account. Same freshly-read-list guard discipline as {@link changeUserRole}. */
export async function deleteManagedUser(
  repo: UsersRepo,
  actorId: string,
  targetId: string,
): Promise<ActionResult> {
  const users = await repo.listUsers();
  const verdict = canDeleteUser(users, actorId, targetId);
  if (!verdict.allowed) return { ok: false, error: verdict.reason };
  await repo.deleteUser(targetId);
  return { ok: true };
}

/**
 * Flips one cell of the permission matrix. `canSetRolePermission` is a pure
 * function of (role, permission, enabled) rather than the user list, so
 * there is no stale-snapshot hazard here — but the guard still runs inside
 * the service, immediately before the write, so no caller can bypass it.
 */
export async function setRolePermissionChecked(
  repo: UsersRepo,
  role: AppRole,
  permission: AppPermission,
  enabled: boolean,
): Promise<ActionResult> {
  const verdict = canSetRolePermission(role, permission, enabled);
  if (!verdict.allowed) return { ok: false, error: verdict.reason };
  await repo.setRolePermission(role, permission, enabled);
  return { ok: true };
}

/** Grants a user access to a site. No lockout guard applies to this operation. */
export async function grantSiteAccess(
  repo: UsersRepo,
  userId: string,
  siteId: string,
  level: SiteAccessLevel,
  grantedBy: string,
): Promise<void> {
  await repo.grantSite(userId, siteId, level, grantedBy);
}

/** Revokes a user's access to a site. No lockout guard applies to this operation. */
export async function revokeSiteAccess(repo: UsersRepo, userId: string, siteId: string): Promise<void> {
  await repo.revokeSite(userId, siteId);
}

export async function listSiteGrants(repo: UsersRepo, userId: string): Promise<SiteGrant[]> {
  return repo.listGrants(userId);
}

export async function listRolePermissions(repo: UsersRepo): Promise<RolePermissionRow[]> {
  return repo.listRolePermissions();
}

/** Invites a new account by email, returning the copyable action link when Supabase provides one. */
export async function inviteNewUser(
  repo: UsersRepo,
  email: string,
  redirectTo: string,
): Promise<{ id: string; inviteLink: string | null }> {
  return repo.inviteUser(email, redirectTo);
}
