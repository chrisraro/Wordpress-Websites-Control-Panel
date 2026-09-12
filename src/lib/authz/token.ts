import { loadViewer } from "./server";
import { type AppPermission } from "./types";
import type { Viewer } from "./decide";
import { hashToken } from "@/services/tokens/service";
import type { TokensRepo } from "@/services/tokens/repo";

export interface TokenAuth {
  viewer: Viewer;
  tokenId: string;
  readOnly: boolean;
}

/**
 * Permission suffixes that denote a write. Anything ending in one of these is
 * removed from a read-only token's viewer. Expressed as suffixes rather than a
 * hardcoded list so a permission added to APP_PERMISSIONS later is read-only
 * by default -- the safe direction. tests/mcp-identity.test.ts asserts the
 * resulting set against the current vocabulary, so a new permission that ought
 * to be stripped but is not matched here fails the suite loudly.
 */
const WRITE_SUFFIXES = [".manage", ".run", ".generate", ".process"] as const;

function isWrite(p: AppPermission): boolean {
  return WRITE_SUFFIXES.some((s) => p.endsWith(s));
}

/** Pure. Returns a new Viewer; never mutates the one passed in. */
export function applyReadOnly(viewer: Viewer): Viewer {
  const permissions = new Set<AppPermission>();
  for (const p of viewer.permissions) if (!isWrite(p)) permissions.add(p);
  const grants = new Map<string, "read" | "manage">();
  for (const siteId of viewer.grants.keys()) grants.set(siteId, "read");
  return { id: viewer.id, email: viewer.email, role: viewer.role, permissions, grants };
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
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return null;

  // Email is not stored on the token row; the viewer's identity fields come
  // from loadViewer, the same function the session path uses.
  const base = await load(row.user_id, null);
  if (!base) return null;

  // Fire-and-forget: a token that works must not stop working because a
  // bookkeeping write failed.
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
