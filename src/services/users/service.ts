import type { AppPermission, AppRole, SiteAccessLevel } from "@/lib/authz/types";
import { canChangeRole, canDeleteUser, canGrantSiteAccess, canSetRolePermission } from "./guards";
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
 *
 * Same freshness discipline for the target's site grants: fetched here,
 * right before the write, only when `next` is `client` (the one transition
 * `canChangeRole` consults them for — see its own comment) so an unrelated
 * role change never pays for a query it does not need.
 */
export async function changeUserRole(
  repo: UsersRepo,
  actorId: string,
  targetId: string,
  next: AppRole,
): Promise<ActionResult> {
  const users = await repo.listUsers();
  const targetGrants = next === "client" ? await repo.listGrants(targetId) : [];
  const verdict = canChangeRole(users, targetId, next, targetGrants);
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

/**
 * Grants a user access to a site. Not a lockout guard, but the same
 * freshly-read discipline as changeUserRole/deleteManagedUser above: the
 * target's role is read from the repo right here, at the moment of the
 * write, never taken as a parameter from a caller that may be holding a
 * role the page rendered a moment ago. See canGrantSiteAccess for why a
 * `manage`-level grant onto a `client` is refused.
 */
export async function grantSiteAccess(
  repo: UsersRepo,
  userId: string,
  siteId: string,
  level: SiteAccessLevel,
  grantedBy: string,
): Promise<ActionResult> {
  const target = await repo.getUser(userId);
  const verdict = canGrantSiteAccess(target?.role ?? null, level);
  if (!verdict.allowed) return { ok: false, error: verdict.reason };
  await repo.grantSite(userId, siteId, level, grantedBy);
  return { ok: true };
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

/**
 * Deletes an account this same request just created, before any external actor
 * could observe or rely on it. Deliberately skips the lockout guards: those
 * protect real administrators from being removed, and a half-created invite is
 * not one — applying them here can refuse to clean up an account that should
 * never have existed, which is strictly worse than removing it.
 *
 * Never use this to delete an account a caller intends to remove. That is
 * deleteManagedUser, and it must stay guarded.
 */
export async function rollbackFailedInvite(repo: UsersRepo, userId: string): Promise<void> {
  await repo.deleteUser(userId);
}
