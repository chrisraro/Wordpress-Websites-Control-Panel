/**
 * Which matrix cells need a confirmation before a *grant* (never a revoke),
 * and the copy that dialog shows.
 *
 * `client` is the one role in APP_ROLES that is an external customer of the
 * agency, not staff. Every other role's permissions only ever widen what
 * that *staff member* can do; granting one of these four to `client`
 * instead widens what every customer account can do to every OTHER
 * customer's data -- it crosses a tenant boundary, not just a capability
 * boundary. That is the criterion for membership in
 * CLIENT_CROSS_TENANT_PERMISSIONS: does granting this permission to `client`
 * let one customer reach something that belongs to a different customer? A
 * permission added to APP_PERMISSIONS later should be evaluated against
 * that same question rather than silently defaulting to "no confirmation
 * needed".
 *
 * Revoking is excluded on purpose: revoking a permission can only narrow
 * access, never grant it, so it is never the mis-click this guards against
 * and stays a single, uninterrupted click.
 *
 * This is UI friction against a mis-aimed click in a 40-checkbox grid, not
 * an authorization boundary -- `canSetRolePermission` in
 * src/services/users/guards.ts (and the RLS policies behind it) is the real
 * enforcement. A user who cancels this dialog and a user who was never
 * shown it end up equally authorized or unauthorized to make the write;
 * this module only decides whether they get asked first.
 */
import type { AppPermission, AppRole } from "@/lib/authz/types";

export const CLIENT_CROSS_TENANT_PERMISSIONS: readonly AppPermission[] = [
  "sites.view_all",
  "sites.manage",
  "wp_toolkit.manage",
  "users.manage",
];

export interface ClientGrantWarning {
  title: string;
  description: string;
}

/**
 * One entry per permission in CLIENT_CROSS_TENANT_PERMISSIONS, naming the
 * specific consequence of granting it to `client` -- not a generic "are you
 * sure?". `sites.view_all` gets the longest copy because its blast radius
 * is the least obvious from the permission's own name: it does not just
 * reveal every site, it also unlocks the WordPress administrator list
 * (site_admin_users_read) for every one of those sites, by virtue of
 * canAccessSite's short-circuit in src/lib/authz/decide.ts and the matching
 * has_site_access short-circuit in the RLS policies.
 */
export const CLIENT_GRANT_WARNINGS: Partial<Record<AppPermission, ClientGrantWarning>> = {
  "sites.view_all": {
    title: "Give every Client account every site on the panel?",
    description:
      "This is the widest permission in the matrix. It bypasses per-site grants entirely, so " +
      "every account with the Client role -- an external customer of the agency, not staff -- " +
      "would immediately be able to read every OTHER customer's site: their content, settings, " +
      "and activity. It also unlocks the WordPress administrator list for each of those sites, " +
      "so those same client accounts would gain every administrator's login name and email " +
      "address across the whole panel. This takes effect on each affected client's next " +
      "request, with no further confirmation.",
  },
  "sites.manage": {
    title: "Give every Client account write access to every site?",
    description:
      "Every account with the Client role -- an external customer, not staff -- would be able " +
      "to connect, edit, or disable any OTHER customer's site, including its credentials, not " +
      "only sites granted to them. This takes effect on each affected client's next request.",
  },
  "wp_toolkit.manage": {
    title: "Give every Client account WP Toolkit on every site?",
    description:
      "Every account with the Client role -- an external customer, not staff -- would be able " +
      "to install, update, or remove plugins, themes, and WordPress core, and run maintenance " +
      "or bulk actions, on every OTHER customer's site, not only sites granted to them. This " +
      "takes effect on each affected client's next request.",
  },
  "users.manage": {
    title: "Give every Client account the whole user directory?",
    description:
      "Every account with the Client role -- an external customer, not staff -- would see the " +
      "full account list for the agency and be able to invite people, change anyone's role, and " +
      "edit this very matrix. Manage users is self-elevating, so any one of those client " +
      "accounts could then grant itself Admin. This takes effect on each affected client's " +
      "next request.",
  },
};

/**
 * True only for the specific transition this guards: turning a
 * cross-tenant permission ON for the `client` role. Turning one off, or
 * touching any other role, is never intercepted.
 */
export function requiresClientGrantConfirmation(
  role: AppRole,
  permission: AppPermission,
  granting: boolean,
): boolean {
  return granting && role === "client" && CLIENT_CROSS_TENANT_PERMISSIONS.includes(permission);
}
