"use client";

/**
 * The role control for one account: a select, a save button, and the two
 * things that make changing a role safe --
 *
 * - `verdict` is computed on the server (page.tsx) against a freshly read
 *   user list, via the same `canChangeRole` guard the action itself calls.
 *   It crosses the boundary as a plain { allowed, reason }, never as the
 *   guard function or the user list. When refused, the control stays
 *   visible and disabled with its reason -- an admin needs to see why they
 *   cannot demote themselves, not wonder where the control went. The
 *   server action re-checks against a *fresh* list at write time regardless
 *   of what this verdict says; this is only what the control displays.
 * - Changing your own role, when the guard allows it, opens a confirmation
 *   naming the consequence before it happens -- but only when the
 *   consequence is real. The permission matrix is editable (Task 6), so
 *   whether a role holds `users.manage` is not fixed by the role name alone:
 *   `rolesWithUsersManage` is read fresh from `role_permissions` by the
 *   server (page.tsx) and crossed as a plain array of roles, never a guard
 *   function. The confirmation only fires when the destination role the
 *   admin actually picked is *not* in that list -- see DEMOTE_SELF_WARNING
 *   below. It is a one-way door from the acting admin's own side.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setUserRoleAction } from "../actions";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { buttonClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";
import { APP_ROLES, type AppRole } from "@/lib/authz/types";

const ROLE_LABEL: Record<AppRole, string> = {
  admin: "Admin",
  developer: "Developer",
  content_writer: "Content writer",
  client: "Client",
};

// Exact wording named in the design (docs/superpowers/specs/2026-08-29-
// phase9b-user-management-design.md §4): a hard, named consequence, not a
// generic "are you sure?" -- the acting admin cannot undo this themselves.
const DEMOTE_SELF_WARNING =
  "You will lose access to user management immediately, and you won't be able to undo this " +
  "yourself -- another administrator will need to change it back for you.";

export function RoleForm({
  targetId, currentRole, isSelf, verdict, rolesWithUsersManage,
}: {
  targetId: string;
  currentRole: AppRole | null;
  isSelf: boolean;
  verdict: { allowed: boolean; reason?: string };
  /** Roles that currently hold `users.manage`, read fresh from `role_permissions`. */
  rolesWithUsersManage: AppRole[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [role, setRole] = useState<AppRole | "">(currentRole ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const changed = role !== "" && role !== currentRole;
  const canSubmit = changed && verdict.allowed && !pending;
  // Only meaningful for isSelf, but computed regardless of it -- cheap, and
  // keeps the condition below a single readable expression.
  const destinationKeepsUsersManage = role !== "" && rolesWithUsersManage.includes(role);
  const losesUsersManage = isSelf && !destinationKeepsUsersManage;

  function submit() {
    if (role === "") return;
    startTransition(async () => {
      const result = await setUserRoleAction(targetId, role);
      if (result.ok) {
        toast({ tone: "success", title: "Role updated" });
        router.refresh();
      } else {
        toast({ tone: "error", title: "Could not change the role", description: result.error });
      }
    });
  }

  function handleSaveClick() {
    if (!canSubmit) return;
    // Only the acting admin's own row can trigger this, and only when the
    // destination role actually lacks users.manage -- the permission matrix
    // is editable, so a self-change is not always a loss of access even when
    // it looks like a demotion. Every other change is guarded server-side
    // but not otherwise consequential enough to interrupt.
    if (losesUsersManage) {
      setConfirmOpen(true);
    } else {
      submit();
    }
  }

  return (
    <div className="space-y-4">
      {currentRole === null && (
        <p className={hintClass}>
          This account has no role yet. It can sign in, but sees nothing until you set one below.
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label htmlFor="role-select" className={labelClass}>
            Role
          </label>
          <select
            id="role-select"
            value={role}
            onChange={(e) => setRole(e.target.value as AppRole)}
            className={inputClass}
          >
            {currentRole === null && (
              <option value="" disabled>
                No role — sees nothing
              </option>
            )}
            {APP_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={handleSaveClick}
          disabled={!canSubmit}
          className={buttonClass("primary")}
        >
          {pending && <IconSpinner size={16} />}
          {pending ? "Saving…" : "Save role"}
        </button>
      </div>

      {!verdict.allowed && (
        <p className="flex items-start gap-2 text-body text-ember">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          {verdict.reason}
        </p>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={`Change your own role to ${role ? ROLE_LABEL[role as AppRole] : "this role"}?`}
        description={DEMOTE_SELF_WARNING}
        confirmLabel="Change my role"
        tone="danger"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          submit();
        }}
      />
    </div>
  );
}
