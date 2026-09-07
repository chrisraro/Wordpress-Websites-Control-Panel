import { createSign } from "node:crypto";
import { getOptionalEnv } from "@/lib/env";

/**
 * Service-account access tokens for the Google APIs this panel reads.
 *
 * A service account rather than OAuth, because every caller here is a cron
 * job. Storing and refreshing a user's OAuth grant would mean a credential
 * that silently expires when someone leaves, revokes access, or changes their
 * password -- and the failure would surface as empty charts rather than as an
 * error. A service account is added as a *user* on each property instead, so
 * access is granted per property and is visible in Google's own UI.
 *
 * Signed here with node:crypto rather than google-auth-library. The whole
 * flow is one RS256 JWT exchanged for a token; the library would add a
 * dependency tree to a project that deliberately has eleven dependencies.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Read-only scopes. This panel never writes to Google. */
export const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
].join(" ");

const TOKEN_URI = "https://oauth2.googleapis.com/token";

/**
 * Parses GOOGLE_SERVICE_ACCOUNT_JSON, returning undefined when unset.
 *
 * Undefined is not an error: like WORDFENCE_API_KEY, an unconfigured
 * integration must leave the rest of the scan working rather than fail it.
 * A *malformed* value is a different thing and does throw -- someone pasted
 * something, and silently ignoring it would leave them staring at empty
 * charts with no reason given.
 */
export function readServiceAccount(): ServiceAccount | undefined {
  const raw = getOptionalEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    // Accept base64 too: pasting raw JSON with newlines into some env UIs
    // mangles the private key, and base64 is the usual workaround.
    const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    parsed = JSON.parse(text);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64-encoded JSON).");
  }
  const sa = parsed as Partial<ServiceAccount>;
  if (!sa?.client_email || !sa?.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
  }
  return { client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri };
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/[=]+$/, "");

/** The signed assertion Google exchanges for an access token. */
export function buildAssertion(sa: ServiceAccount, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPES,
    aud: sa.token_uri || TOKEN_URI,
    iat: nowSeconds,
    // One hour is Google's maximum. Shorter would mean more token round
    // trips for no security gain, since the assertion is signed per request.
    exp: nowSeconds + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  // Env UIs commonly store the PEM with literal backslash-n; normalise both
  // forms rather than making the operator get it exactly right.
  const pem = sa.private_key.includes(String.fromCharCode(92) + "n")
    ? sa.private_key.split(String.fromCharCode(92) + "n").join(String.fromCharCode(10))
    : sa.private_key;
  return `${header}.${claims}.${b64url(signer.sign(pem))}`;
}

interface CachedToken { token: string; expiresAt: number }
let cached: CachedToken | null = null;

/**
 * An access token, cached until shortly before it expires.
 *
 * The cache is module-level and therefore per serverless instance, which is
 * the right scope: a token is not worth persisting, and an instance handling
 * a fan-out across twelve sites would otherwise mint twelve identical ones.
 */
export async function getAccessToken(
  fetchImpl: typeof fetch = fetch, now: () => number = Date.now,
): Promise<string | undefined> {
  const sa = readServiceAccount();
  if (!sa) return undefined;

  // 60s of slack, so a token cannot expire between this check and the call
  // that uses it.
  if (cached && cached.expiresAt - 60_000 > now()) return cached.token;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: buildAssertion(sa, Math.floor(now() / 1000)),
  });
  const res = await fetchImpl(sa.token_uri || TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // Google's error body names the real cause ("invalid_grant" for a clock
    // skew or a deleted key), and losing it would leave only "HTTP 400".
    throw new Error(`Google token request failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Google token response contained no access_token.");
  cached = {
    token: json.access_token,
    expiresAt: now() + (json.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** Test seam: the cache is process-wide and would leak between cases. */
export function resetTokenCacheForTests(): void {
  cached = null;
}
