"use client";

/**
 * The permission matrix: one row per permission, one column per role,
 * writing `role_permissions` a cell at a time through `setRolePermissionAction`.
 *
 * A click flips its checkbox immediately (optimistic) and starts a
 * transition to persist it. `admin` * `users.manage` never round-trips a
 * click at all -- the server refuses to disable it (see
 * `canSetRolePermission` in src/services/users/guards.ts), so the cell
 * renders permanently checked and disabled here, with the same reason the
 * server would give, both as a native `title` and as a standing note under
 * the table -- a hover-only tooltip is not a "visible reason".
 *
 * Every other cell reverts to its prior value on failure rather than
 * leaving the checkbox disagreeing with the database, and toasts either way.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setRolePermissionAction } from "../actions";
import { useToast } from "@/components/ui/toast";
import { cardClass, cardFooterClass, hintClass, tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconInfo } from "@/components/ui/icons";
import { APP_PERMISSIONS, APP_ROLES, type AppPermission, type AppRole } from "@/lib/authz/types";

const ROLE_LABEL: Record<AppRole, string> = {
  admin: "Admin",
  developer: "Developer",
  content_writer: "Content writer",
  client: "Client",
};

const PERMISSION_LABEL: Record<AppPermission, string> = {
  "sites.view_all": "View all sites",
  "sites.manage": "Manage sites",
  "wp_toolkit.manage": "WP Toolkit",
  "security.run": "Run security scans",
  "seo.run": "Run SEO scans",
  "geogrid.manage": "Manage GeoGrid",
  "reports.generate": "Generate reports",
  "reports.manage": "Manage reports",
  "queue.process": "Process the job queue",
  "users.manage": "Manage users",
};

/**
 * Verbatim from the enum comments in supabase/migrations/0006_rbac_schema.sql,
 * so the UI and the schema can never describe a permission differently.
 */
const PERMISSION_DESCRIPTION: Record<AppPermission, string> = {
  "sites.view_all": "See every site rather than only granted ones.",
  "sites.manage": "Connect, edit, or disable a site; touches credentials.",
  "wp_toolkit.manage": "Plugins, themes, core, maintenance, child themes, bulk actions.",
  "security.run": "Run a security scan.",
  "seo.run": "Run an SEO/AEO scan.",
  "geogrid.manage": "Configure and run GeoGrid.",
  "reports.generate": "Generate a report.",
  "reports.manage": "Revoke share links.",
  "queue.process": "Drain the job queue on demand.",
  "users.manage": "Invite users, set roles, edit the matrix.",
};

// Mirrors canSetRolePermission's refusal in src/services/users/guards.ts
// word for word -- this is the UI stating the same reason the server
// enforces, not a second, independent rule that could drift from it.
const ADMIN_USERS_MANAGE_REASON =
  "Administrators must keep Manage users, or nobody could repair this matrix again.";

export interface RolePermissionCell {
  role: AppRole;
  permission: AppPermission;
}

function cellKey(role: AppRole, permission: AppPermission): string {
  return `${role}:${permission}`;
}

function isLocked(role: AppRole, permission: AppPermission): boolean {
  return role === "admin" && permission === "users.manage";
}

export function PermissionMatrix({ rolePermissions }: { rolePermissions: RolePermissionCell[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(rolePermissions.map((r) => cellKey(r.role, r.permission))),
  );
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  function toggle(role: AppRole, permission: AppPermission) {
    if (isLocked(role, permission)) return;

    const key = cellKey(role, permission);
    const wasEnabled = enabled.has(key);
    const next = !wasEnabled;

    setEnabled((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
    setPendingKeys((prev) => new Set(prev).add(key));

    startTransition(async () => {
      const result = await setRolePermissionAction(role, permission, next);
      setPendingKeys((prev) => {
        const copy = new Set(prev);
        copy.delete(key);
        return copy;
      });
      if (result.ok) {
        toast({
          tone: "success",
          title: next ? "Permission granted" : "Permission removed",
          description: `${PERMISSION_LABEL[permission]} for ${ROLE_LABEL[role]}.`,
        });
        router.refresh();
      } else {
        // The database refused (or the write failed) -- the checkbox must
        // never keep showing a state that was never actually persisted.
        setEnabled((prev) => {
          const copy = new Set(prev);
          if (wasEnabled) copy.add(key);
          else copy.delete(key);
          return copy;
        });
        toast({ tone: "error", title: "Could not update the permission", description: result.error });
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className={`${cardClass} space-y-2 p-5`}>
        <p className="flex items-start gap-2 text-body text-ink">
          <IconInfo size={16} className="mt-0.5 shrink-0 text-mid-gray" />
          Changes take effect on each affected person&apos;s next request. Permissions are read
          fresh on every request rather than carried in a sign-in token, precisely so a
          revocation is immediate.
        </p>
        <p className="flex items-start gap-2 text-body text-ink">
          <IconInfo size={16} className="mt-0.5 shrink-0 text-mid-gray" />
          Manage users is self-elevating: anyone holding it can grant themselves Admin. That is
          what the permission means, not a defect.
        </p>
      </div>

      <div className={`${cardClass} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-body">
            <thead>
              <tr className={tableHeadClass}>
                <th className="px-5 py-3 font-medium">Permission</th>
                {APP_ROLES.map((role) => (
                  <th key={role} className="px-5 py-3 text-center font-medium">
                    {ROLE_LABEL[role]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {APP_PERMISSIONS.map((permission) => (
                <tr key={permission} className={tableRowClass}>
                  <td className={`${tableCellClass} align-top`}>
                    <p className="font-medium text-ink">{PERMISSION_LABEL[permission]}</p>
                    <p className={hintClass}>{PERMISSION_DESCRIPTION[permission]}</p>
                  </td>
                  {APP_ROLES.map((role) => {
                    const locked = isLocked(role, permission);
                    const key = cellKey(role, permission);
                    const checked = locked || enabled.has(key);
                    const disabled = locked || pendingKeys.has(key);
                    return (
                      <td key={role} className={`${tableCellClass} text-center`}>
                        <label
                          className={`inline-flex min-h-10 w-10 items-center justify-center ${
                            locked ? "cursor-not-allowed" : "cursor-pointer"
                          }`}
                          title={locked ? ADMIN_USERS_MANAGE_REASON : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggle(role, permission)}
                            aria-label={`${PERMISSION_LABEL[permission]} for ${ROLE_LABEL[role]}`}
                            aria-describedby={locked ? "admin-users-manage-note" : undefined}
                            className="size-4 shrink-0 rounded-md accent-ink disabled:opacity-60"
                          />
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p id="admin-users-manage-note" className={cardFooterClass}>
          {ADMIN_USERS_MANAGE_REASON}
        </p>
      </div>
    </div>
  );
}
