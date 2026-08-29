import type { AppPermission, AppRole } from "@/lib/authz/types";
import { ALLOWED, refuse, type GuardVerdict, type ManagedUser } from "@/services/users/types";

/**
 * These refuse operations that would leave the panel unadministrable. Recovery
 * from any of them means raw SQL against production, so each is a hard refusal
 * rather than a warning — and each is enforced in the server action, not only
 * by hiding a control.
 */

/**
 * True when `target` is an admin and is the only *distinct* admin in `users`.
 * Guards against the last real administrator being demoted or deleted.
 *
 * Counts distinct admin ids, not rows: callers may hand us a list with a
 * duplicated admin row (e.g. a join fan-out upstream), and counting rows
 * would undercount how many admins actually remain, letting the sole admin
 * be demoted or deleted. Do not "simplify" this back to `admins.length`.
 */
function isSoleAdmin(users: ManagedUser[], target: ManagedUser): boolean {
  if (target.role !== "admin") return false;
  const admins = users.filter((u) => u.role === "admin");
  const distinctAdminIds = new Set(admins.map((u) => u.id));
  return distinctAdminIds.size <= 1;
}

export function canChangeRole(
  users: ManagedUser[], targetId: string, next: AppRole,
): GuardVerdict {
  const target = users.find((u) => u.id === targetId);
  if (!target) return refuse("That account no longer exists.");
  if (target.role === next) return ALLOWED;

  if (isSoleAdmin(users, target)) {
    return refuse("This is the last administrator. Promote someone else first.");
  }
  return ALLOWED;
}

export function canDeleteUser(
  users: ManagedUser[], actorId: string, targetId: string,
): GuardVerdict {
  const target = users.find((u) => u.id === targetId);
  if (!target) return refuse("That account no longer exists.");
  // Deleting yourself is refused outright, not just when you are the last
  // admin: signing yourself out of the product permanently should go through
  // someone else.
  if (targetId === actorId) return refuse("You cannot delete your own account. Ask another admin.");

  if (isSoleAdmin(users, target)) {
    return refuse("This is the last administrator. Promote someone else first.");
  }
  return ALLOWED;
}

export function canSetRolePermission(
  role: AppRole, permission: AppPermission, enabled: boolean,
): GuardVerdict {
  if (role === "admin" && permission === "users.manage" && !enabled) {
    return refuse(
      "Administrators must keep Manage users, or nobody could repair this matrix again.",
    );
  }
  return ALLOWED;
}
