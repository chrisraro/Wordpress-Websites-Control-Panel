/**
 * Pure authorization decision logic — no imports from Supabase, Next.js, or
 * anything with I/O. This mirrors the `authorize` / `has_site_access`
 * Postgres functions (see supabase/migrations and
 * docs/superpowers/specs/2026-08-29-phase9a-authorization-design.md §3) so it
 * can be exhaustively table-tested, and so Client Components can reuse the
 * same rules for presentation without round-tripping to the server.
 *
 * Keep this file free of side effects: `src/lib/authz/server.ts` is the only
 * place that fetches the data a Viewer is built from.
 */
import type { AppPermission, AppRole, SiteAccessLevel } from "./types";

export interface Viewer {
  id: string;
  email: string | null;
  role: AppRole;
  permissions: Set<AppPermission>;
  grants: Map<string, SiteAccessLevel>;
}

/** Does the viewer hold this permission, after role defaults and overrides? */
export function can(viewer: Viewer, permission: AppPermission): boolean {
  return viewer.permissions.has(permission);
}

/**
 * Can the viewer reach `siteId` at least at level `min`?
 *
 * `sites.view_all` reaches any site at any level. Otherwise the viewer needs
 * a grant whose level satisfies the minimum: `manage` satisfies both `read`
 * and `manage`; `read` satisfies only `read`.
 */
export function canAccessSite(
  viewer: Viewer,
  siteId: string,
  min: SiteAccessLevel = "read",
): boolean {
  if (can(viewer, "sites.view_all")) return true;

  const level = viewer.grants.get(siteId);
  if (!level) return false;
  if (min === "read") return true; // any grant (read or manage) satisfies read
  return level === "manage";
}

/**
 * The set of site ids the viewer may see at all (read level), out of
 * `allIds`. Returns the literal string "all" rather than a copy of `allIds`
 * when the viewer holds `sites.view_all`, so callers can skip filtering.
 */
export function visibleSiteIds(viewer: Viewer, allIds: string[]): string[] | "all" {
  if (can(viewer, "sites.view_all")) return "all";
  return allIds.filter((id) => viewer.grants.has(id));
}
