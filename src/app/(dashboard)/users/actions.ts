"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";
import { checkPermission, isDenied } from "@/lib/authz/server";
import { APP_ROLES, type AppPermission, type AppRole, type SiteAccessLevel } from "@/lib/authz/types";
import { getOptionalEnv } from "@/lib/env";
import { supabaseUsersRepo } from "@/services/users/repo";
import {
  changeUserRole,
  deleteManagedUser,
  grantSiteAccess,
  inviteNewUser,
  revokeSiteAccess,
  rollbackFailedInvite,
  setRolePermissionChecked,
} from "@/services/users/service";

export type ActionResult = { ok: true } | { ok: false; error: string };
export type InviteResult = ActionResult & { inviteLink?: string | null };

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  role: z.enum(APP_ROLES),
  siteIds: z.array(z.string()).default([]),
});

function repo() {
  return supabaseUsersRepo(createServiceSupabase());
}

/**
 * Every exported function here is a "use server" action, which means it is a
 * publicly invokable HTTP endpoint whether or not any page in this app calls
 * it. Each one starts with the same two lines — requireUser() for an actor
 * id, then checkPermission("users.manage") — so none of them can be reached
 * by someone who lacks that permission, regardless of what the UI shows.
 */

export async function inviteUserAction(
  _prevState: InviteResult | undefined,
  formData: FormData,
): Promise<InviteResult> {
  const user = await requireUser();
  const gate = await checkPermission("users.manage");
  if (isDenied(gate)) return gate;

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
    siteIds: formData.getAll("siteIds").map(String),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { email, role, siteIds } = parsed.data;
  // A client with no site grants has an empty dashboard and can do nothing —
  // checked here too, not only by the form, since this action is reachable
  // directly.
  if (role === "client" && siteIds.length === 0) {
    return { ok: false, error: "A client must be granted at least one site." };
  }

  const users = repo();
  const appUrl = (getOptionalEnv("APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "");

  let invited: { id: string; inviteLink: string | null };
  try {
    invited = await inviteNewUser(users, email, `${appUrl}/login`);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not create the account" };
  }

  // Order matters: a user with no role row is denied everything by
  // getViewer(), so a half-created account can sign in and see nothing with
  // no explanation. Role and grants go through the guarded service
  // functions, exactly like every other mutation in this module — an
  // invite is not a special case that gets to skip the lockout guards.
  try {
    const roleResult = await changeUserRole(users, user.id, invited.id, role);
    if (!roleResult.ok) throw new Error(roleResult.error);
    for (const siteId of siteIds) {
      await grantSiteAccess(users, invited.id, siteId, "read", user.id);
    }
  } catch (failure) {
    // Undo the just-created account. This must use rollbackFailedInvite, not
    // the guarded deleteManagedUser: by the time a grant fails, changeUserRole
    // may already have committed an "admin" role onto this brand-new account,
    // and if that account is now the only admin (e.g. the inviting actor holds
    // users.manage without being an admin themselves — the permission matrix
    // is editable), the lockout guard in deleteManagedUser will refuse to
    // remove it. That refusal must never be swallowed: a live, fully-
    // privileged admin account would then exist while this action reports
    // that nothing was kept.
    const failureReason = failure instanceof Error ? failure.message : String(failure);
    try {
      await rollbackFailedInvite(users, invited.id);
    } catch (rollbackFailure) {
      const rollbackReason =
        rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
      return {
        ok: false,
        error:
          `Could not finish creating the account, and cleanup also failed: the account ` +
          `${email} (${invited.id}) still exists with no usable access. Remove it from the ` +
          `user list manually. (Setup error: ${failureReason}. Cleanup error: ${rollbackReason})`,
      };
    }
    return { ok: false, error: "Could not finish creating the account — nothing was kept." };
  }

  revalidatePath("/users");
  return { ok: true, inviteLink: invited.inviteLink };
}

export async function setUserRoleAction(
  userId: string,
  role: AppRole,
  _prevState?: ActionResult,
  _formData?: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const gate = await checkPermission("users.manage");
  if (isDenied(gate)) return gate;

  let result: ActionResult;
  try {
    result = await changeUserRole(repo(), user.id, userId, role);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not change the role" };
  }
  // A guard refusal means nothing was written — only revalidate on an
  // actual change, so a lockout refusal doesn't churn the cache for no
  // reason.
  if (result.ok) {
    revalidatePath("/users");
    revalidatePath(`/users/${userId}`);
  }
  return result;
}

/**
 * Bound as `deleteUserAction.bind(null, userId)` and handed to `ManageForm`
 * (see src/app/(dashboard)/sites/[id]/action-form.tsx) exactly like
 * testConnectionAction and the manage-actions in sites/[id] -- so, like
 * those, the prevState parameter is typed as the loose `{ ok; error? } |
 * null` shape ManageForm's useActionState expects, not the stricter
 * `ActionResult` used for this account's own return value and elsewhere in
 * this module.
 */
export async function deleteUserAction(
  userId: string,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const gate = await checkPermission("users.manage");
  if (isDenied(gate)) return gate;

  let result: ActionResult;
  try {
    result = await deleteManagedUser(repo(), user.id, userId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not delete the account" };
  }
  if (result.ok) {
    revalidatePath("/users");
    revalidatePath(`/users/${userId}`);
    // Mirrors createSite's redirect() in sites/new/actions.ts: the page this
    // account was on no longer refers to anything, so leave for the
    // directory immediately rather than lingering. Called outside the
    // try/catch above -- redirect() throws a NEXT_REDIRECT digest that must
    // propagate, not be caught as a failure.
    redirect("/users");
  }
  return result;
}

export async function grantSiteAction(
  userId: string,
  siteId: string,
  level: SiteAccessLevel,
  _prevState?: ActionResult,
  _formData?: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const gate = await checkPermission("users.manage");
  if (isDenied(gate)) return gate;

  try {
    await grantSiteAccess(repo(), userId, siteId, level, user.id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not grant site access" };
  }
  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
  return { ok: true };
}

export async function revokeSiteAction(
  userId: string,
  siteId: string,
  _prevState?: ActionResult,
  _formData?: FormData,
): Promise<ActionResult> {
  await requireUser();
  const gate = await checkPermission("users.manage");
  if (isDenied(gate)) return gate;

  try {
    await revokeSiteAccess(repo(), userId, siteId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not revoke site access" };
  }
  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
  return { ok: true };
}

export async function setRolePermissionAction(
  role: AppRole,
  permission: AppPermission,
  enabled: boolean,
  _prevState?: ActionResult,
  _formData?: FormData,
): Promise<ActionResult> {
  await requireUser();
  const gate = await checkPermission("users.manage");
  if (isDenied(gate)) return gate;

  let result: ActionResult;
  try {
    result = await setRolePermissionChecked(repo(), role, permission, enabled);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not update the permission matrix" };
  }
  if (result.ok) revalidatePath("/users");
  return result;
}
