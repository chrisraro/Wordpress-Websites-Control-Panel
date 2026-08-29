import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { APP_ROLES, type AppPermission, type SiteAccessLevel } from "./types";
import { can, canAccessSite, type Viewer } from "./decide";

/**
 * Role, permissions and grants are read per request rather than carried in the
 * JWT, so removing someone's access takes effect on their next request instead
 * of whenever their token happens to refresh. cache() keeps that to one round
 * of queries per render.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const auth = await createServerSupabase();
  const { data } = await auth.auth.getUser();
  if (!data.user) return null;

  const db = createServiceSupabase();
  const [roleRow, overrides, grants] = await Promise.all([
    db.from("user_roles").select("role").eq("user_id", data.user.id).maybeSingle(),
    db.from("user_permission_overrides").select("permission,effect").eq("user_id", data.user.id),
    db.from("user_site_access").select("site_id,access_level").eq("user_id", data.user.id),
  ]);

  // A database error is not "no data" — Supabase returns data:[] for a
  // successful query with zero rows, and data:null (with .error set) when
  // the query itself failed. Conflating the two would fail OPEN for the
  // overrides query in particular: a `deny` override exists to strip a
  // permission the role would otherwise grant, so if that query errors and
  // we treated it as "no overrides", the role default would silently win
  // and the user would keep a permission that was explicitly revoked. A
  // database error means we do not know what this user may do, and the
  // only safe answer to that is nothing — so any of the four queries
  // erroring denies the viewer entirely.
  if (roleRow.error) {
    console.error("[authz] failed to load viewer:", "user_roles", roleRow.error.message);
    return null;
  }
  if (overrides.error) {
    console.error("[authz] failed to load viewer:", "user_permission_overrides", overrides.error.message);
    return null;
  }
  if (grants.error) {
    console.error("[authz] failed to load viewer:", "user_site_access", grants.error.message);
    return null;
  }

  // No role row means no access at all — fail closed. This is why the
  // bootstrap script must run before enforcement ships.
  const roleValue = roleRow.data?.role;
  const role = APP_ROLES.find((r) => r === roleValue);
  if (!role) return null;

  const rolePerms = await db
    .from("role_permissions").select("permission").eq("role", role);
  if (rolePerms.error) {
    console.error("[authz] failed to load viewer:", "role_permissions", rolePerms.error.message);
    return null;
  }

  const permissions = new Set<AppPermission>(
    (rolePerms.data ?? []).map((r) => r.permission as AppPermission),
  );
  for (const o of overrides.data ?? []) {
    if (o.effect === "allow") permissions.add(o.permission as AppPermission);
    else permissions.delete(o.permission as AppPermission);
  }

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    role,
    permissions,
    grants: new Map((grants.data ?? []).map((g) => [g.site_id, g.access_level as SiteAccessLevel])),
  };
});

/** For pages: a viewer who may not see this thing is told it does not exist. */
export function denyNotFound(): never {
  notFound();
}

export async function requireViewer(): Promise<Viewer> {
  const v = await getViewer();
  if (!v) denyNotFound();
  return v;
}

export async function requirePermission(p: AppPermission): Promise<Viewer> {
  const v = await requireViewer();
  if (!can(v, p)) denyNotFound();
  return v;
}

export async function requireSiteAccess(
  siteId: string, min: SiteAccessLevel = "read",
): Promise<Viewer> {
  const v = await requireViewer();
  if (!canAccessSite(v, siteId, min)) denyNotFound();
  return v;
}

/**
 * Server-action variants: a `"use server"` action returning `{ok:false}`
 * renders an inline error, whereas notFound() thrown inside an action is a
 * poor experience. These share the exact same decision logic as the
 * `require*` functions above (via getViewer/can/canAccessSite) so the two
 * families cannot diverge — only how each reports "no" is different.
 */
export type Denied = { ok: false; error: string };
const DENIED: Denied = { ok: false, error: "You do not have permission to do that." };

export function isDenied(x: unknown): x is Denied {
  return typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false;
}

export async function checkPermission(p: AppPermission): Promise<Viewer | Denied> {
  const v = await getViewer();
  if (!v || !can(v, p)) return DENIED;
  return v;
}

export async function checkSiteAccess(
  siteId: string, min: SiteAccessLevel = "read",
): Promise<Viewer | Denied> {
  const v = await getViewer();
  if (!v || !canAccessSite(v, siteId, min)) return DENIED;
  return v;
}
