import type { AppPermission, AppRole } from "@/lib/authz/types";
import { ALLOWED, refuse, type GuardVerdict, type ManagedUser } from "@/services/users/types";

/**
 * These refuse operations that would leave the panel unadministrable. Recovery
 * from any of them means raw SQL against production, so each is a hard refusal
 * rather than a warning — and each is enforced in the server action, not only
 * by hiding a control.
 */
export function canChangeRole(
  users: ManagedUser[], targetId: string, next: AppRole,
): GuardVerdict {
  const target = users.find((u) => u.id === targetId);
  if (!target) return refuse("That account no longer exists.");
  if (target.role === next) return ALLOWED;

  const admins = users.filter((u) => u.role === "admin");
  if (target.role === "admin" && admins.length <= 1) {
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
  if (targetId === actorId) return refuse("You cannot delete your own account.");

  const admins = users.filter((u) => u.role === "admin");
  if (target.role === "admin" && admins.length <= 1) {
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
