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

export async function revokeToken(repo: TokensRepo, tokenId: string): Promise<void> {
  await repo.revoke(tokenId);
}
