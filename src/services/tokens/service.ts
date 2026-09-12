import { createHash, randomBytes } from "node:crypto";
import type { TokensRepo } from "./repo";
import type { ApiTokenRow, TokenExpiry } from "./types";

const SECRET_PREFIX = "wpcp_";
/** Display prefix length, per the spec: the first 8 characters of the secret. */
const PREFIX_LEN = 8;

/** sha256 of the whole secret, including the wpcp_ prefix. Hex. */
export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64url");
}

export function tokenPrefix(secret: string): string {
  return secret.slice(0, PREFIX_LEN);
}

export function expiryToIso(e: TokenExpiry, now: Date): string | null {
  if (e === "none") return null;
  const d = new Date(now.getTime());
  if (e === "30d") d.setUTCDate(d.getUTCDate() + 30);
  else if (e === "90d") d.setUTCDate(d.getUTCDate() + 90);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
}

/**
 * Mints a token and returns the secret. This is the only moment the secret
 * exists in a readable form: only its sha256 is persisted, so it cannot be
 * shown again.
 */
export async function mintToken(
  repo: TokensRepo,
  input: { userId: string; name: string; readOnly: boolean; expiry: TokenExpiry },
): Promise<{ id: string; secret: string }> {
  const secret = generateSecret();
  const { id } = await repo.insert({
    user_id: input.userId,
    name: input.name,
    token_hash: hashToken(secret),
    token_prefix: tokenPrefix(secret),
    read_only: input.readOnly,
    expires_at: expiryToIso(input.expiry, new Date()),
  });
  return { id, secret };
}

export async function listTokens(repo: TokensRepo, userId: string): Promise<ApiTokenRow[]> {
  return repo.listForUser(userId);
}

/**
 * `listTokens` for a page that must keep rendering when the `api_tokens`
 * table is missing (final review, Fix 4). /users/[id] existed and worked
 * before this feature; if a build carrying it serves traffic before
 * migration 0021 is applied, `listForUser` throws on the missing relation
 * and the whole admin page would 500. This turns that one failure into an
 * empty list plus an `unavailable` flag the card renders as a hint, and
 * logs the real error server-side. It deliberately catches everything --
 * distinguishing "relation does not exist" from a transient outage is not
 * worth a 500 on an unrelated page either way -- and is used ONLY for
 * page reads: the token actions still throw, because minting or revoking
 * against a missing table must fail loudly.
 */
export async function listTokensOrUnavailable(
  repo: TokensRepo, userId: string,
): Promise<{ tokens: ApiTokenRow[]; unavailable: boolean }> {
  try {
    return { tokens: await repo.listForUser(userId), unavailable: false };
  } catch (e) {
    console.error("[tokens] listForUser failed -- is migration 0021 (api_tokens) applied?", e);
    return { tokens: [], unavailable: true };
  }
}

export async function revokeToken(repo: TokensRepo, tokenId: string): Promise<void> {
  await repo.revoke(tokenId);
}
