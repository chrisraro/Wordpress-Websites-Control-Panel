/**
 * The authorization vocabulary. These unions mirror the Postgres enums in
 * supabase/migrations/0006_rbac_schema.sql exactly; tests/authz-schema.test.ts
 * fails if the two drift, because a permission that exists on one side only
 * fails silently at runtime.
 */
export const APP_ROLES = ["admin", "developer", "content_writer", "client"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const APP_PERMISSIONS = [
  "sites.view_all",
  "sites.manage",
  "wp_toolkit.manage",
  "security.run",
  "seo.run",
  "geogrid.manage",
  "reports.generate",
  "reports.manage",
  "queue.process",
  "users.manage",
] as const;
export type AppPermission = (typeof APP_PERMISSIONS)[number];

export type SiteAccessLevel = "read" | "manage";
export type OverrideEffect = "allow" | "deny";

/** Seeded once; an admin edits role_permissions afterwards (Phase 9b). */
export const DEFAULT_MATRIX: Record<AppRole, readonly AppPermission[]> = {
  admin: [...APP_PERMISSIONS],
  developer: [
    "sites.view_all", "wp_toolkit.manage", "security.run", "seo.run",
    "geogrid.manage", "reports.generate", "reports.manage", "queue.process",
  ],
  content_writer: ["sites.view_all", "seo.run", "geogrid.manage", "reports.generate"],
  // A client's reach comes from their site grants, not from permissions.
  client: ["reports.generate"],
};
