import { createHmac, timingSafeEqual } from "node:crypto";
import { getOptionalEnv } from "@/lib/env";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Either proof of the shared secret is accepted: an HMAC over the raw body
 * (preferred) or the secret itself in a header (one field to configure in n8n).
 */
export function verifyN8nRequest(rawBody: string, headers: Headers): boolean {
  const secret = getOptionalEnv("N8N_WEBHOOK_SECRET");
  if (!secret) return false;

  const signature = headers.get("x-n8n-signature");
  if (signature) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqual(signature.replace(/^sha256=/i, "").trim().toLowerCase(), expected);
  }
  const bearer = headers.get("x-n8n-secret");
  return bearer !== null && safeEqual(bearer, secret);
}
