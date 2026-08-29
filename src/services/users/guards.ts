import type { AppPermission, AppRole, SiteAccessLevel } from "@/lib/authz/types";
import { ALLOWED, refuse, type GuardVerdict, type ManagedUser, type SiteGrant } from "@/services/users/types";

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

/**
 * `targetGrants` must be the target's `user_site_access` rows, read fresh at
 * the moment of the write (same discipline `canGrantSiteAccess` requires of
 * its caller) — never a snapshot a page rendered earlier. Defaults to `[]`
 * so every existing call site (and every transition other than "to client")
 * is unaffected.
 *
 * Finding 4 of the final whole-branch review: a staff account (`admin`,
 * `developer`, `content_writer`) can legitimately hold a `manage`-level
 * grant — it is inert for them, since staff already reach every site
 * through `sites.view_all` — but demoting that same account to `client`
 * would hand an external customer exactly the live-PHP-execution hole
 * `canGrantSiteAccess` refuses at grant time, without ever going through
 * `grantSiteAccess` at all. Refusing here, rather than silently downgrading
 * the grants to `read`, matches this file's existing convention: a lockout
 * guard never quietly changes something else as a side effect of the
 * operation it is asked to perform.
 */
export function canChangeRole(
  users: ManagedUser[], targetId: string, next: AppRole, targetGrants: SiteGrant[] = [],
): GuardVerdict {
  const target = users.find((u) => u.id === targetId);
  if (!target) return refuse("That account no longer exists.");
  if (target.role === next) return ALLOWED;

  if (isSoleAdmin(users, target)) {
    return refuse("This is the last administrator. Promote someone else first.");
  }

  if (next === "client") {
    const manageSiteIds = targetGrants
      .filter((g) => g.accessLevel === "manage")
      .map((g) => g.siteId);
    if (manageSiteIds.length > 0) {
      return refuse(
        `This account holds manage-level access to ${manageSiteIds.length === 1 ? "a site" : `${manageSiteIds.length} sites`} ` +
          `(${manageSiteIds.join(", ")}). A client with manage-level access could trigger a live ` +
          "inventory refresh, which opens a connection to that site and runs PHP there. " +
          "Downgrade those grants to read before changing this account's role to client.",
      );
    }
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

/**
 * True only for a `manage`-level grant onto a `client`. Per docs/ops/
 * authorization.md, client grants must always be `read` — `manage` is what
 * `refreshInventoryAction` (src/app/(dashboard)/sites/[id]/manage-actions.ts)
 * requires in order to open an MCP connection and run PHP against the
 * site's live WordPress install. A client is an external customer; handing
 * one of them that level of access, even accidentally, is a live-execution
 * hole, not a theoretical one. `target === null` (an account with no role
 * yet — see ManagedUser) and every staff role (`admin`, `developer`,
 * `content_writer`) are unaffected: those roles already reach every site
 * through `sites.view_all`, so a grant adds nothing for them regardless of
 * level.
 *
 * Callers must pass the target's role freshly read at the moment of the
 * write, never a role captured earlier (e.g. by the page that rendered the
 * form) — same discipline as `changeUserRole`'s and `deleteManagedUser`'s
 * freshly-read-list guards in service.ts. `grantSiteAccess` in service.ts
 * enforces that by reading `repo.getUser` itself rather than accepting a
 * role parameter from its caller.
 */
export function canGrantSiteAccess(
  targetRole: AppRole | null,
  level: SiteAccessLevel,
): GuardVerdict {
  if (targetRole === "client" && level === "manage") {
    return refuse(
      "A client can only be granted read access. Manage-level access would let them trigger " +
        "a live inventory refresh, which opens a connection to their WordPress install and " +
        "runs PHP there.",
    );
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
