import { loadViewer } from "./server";
import { type AppPermission, type SiteAccessLevel } from "./types";
import type { Viewer } from "./decide";
import { hashToken } from "@/services/tokens/service";
import type { TokensRepo } from "@/services/tokens/repo";

export interface TokenAuth {
  viewer: Viewer;
  tokenId: string;
  readOnly: boolean;
}

/**
 * Exhaustive classification of every permission as read or write. This is a
 * `Record<AppPermission, ...>`, so adding a permission to APP_PERMISSIONS
 * without adding it here fails `tsc`, not just a test -- there is no way for
 * a new permission to fall through unclassified. tests/mcp-identity.test.ts
 * additionally asserts the key set matches APP_PERMISSIONS exactly, catching
 * the mirror case: a permission removed from APP_PERMISSIONS but left behind
 * here.
 */
export const PERMISSION_KIND: Record<AppPermission, "read" | "write"> = {
  "sites.view_all": "read",
  "sites.manage": "write",
  "wp_toolkit.manage": "write",
  "security.run": "write",
  "seo.run": "write",
  "geogrid.manage": "write",
  "reports.generate": "write",
  "reports.manage": "write",
  "queue.process": "write",
  "users.manage": "write",
};

/** Pure. Returns a new Viewer; never mutates the one passed in. */
export function applyReadOnly(viewer: Viewer): Viewer {
  const permissions = new Set<AppPermission>();
  for (const p of viewer.permissions) if (PERMISSION_KIND[p] === "read") permissions.add(p);
  const grants = new Map<string, SiteAccessLevel>();
  for (const siteId of viewer.grants.keys()) grants.set(siteId, "read");
  return { ...viewer, permissions, grants };
}

/**
 * Resolves a bearer secret to the viewer who minted it.
 *
 * Returns null for every failure -- unknown, revoked, expired, or a user who no
 * longer has a role -- because the caller's only correct response to any of
 * them is the same 401, and distinguishing them would tell a caller whether a
 * given secret was ever real.
 */
export async function authenticateToken(
  secret: string,
  repo: TokensRepo,
  load: (userId: string, email: string | null) => Promise<Viewer | null> = loadViewer,
  now: Date = new Date(),
): Promise<TokenAuth | null> {
  const row = await repo.findByHash(hashToken(secret));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at) {
    const expiresAt = new Date(row.expires_at).getTime();
    // A malformed timestamp yields NaN, and NaN <= now is false, which would
    // treat the token as not expired. Unreachable today since the column is
    // timestamptz, but guard it anyway so an unparseable value fails closed
    // rather than open.
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return null;
  }

  // Email is not stored on the token row; the viewer's identity fields come
  // from loadViewer, the same function the session path uses.
  const base = await load(row.user_id, null);
  if (!base) return null;

  // Swallow failures here: a bookkeeping write must not fail an otherwise
  // valid authentication. This is awaited deliberately rather than left as a
  // floating promise -- this app deploys to Vercel, where a serverless
  // function can freeze as soon as the response is returned, and an
  // un-awaited write may simply never land.
  try {
    await repo.stampUsed(row.id, now.toISOString());
  } catch (e) {
    console.error("[authz] failed to stamp api_token.last_used_at:", e);
  }

  return {
    viewer: row.read_only ? applyReadOnly(base) : base,
    tokenId: row.id,
    readOnly: row.read_only,
  };
}
