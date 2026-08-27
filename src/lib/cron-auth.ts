import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function isAuthorizedCronRequest(req: Request): boolean {
  let secret: string;
  try {
    secret = getEnv("CRON_SECRET");
  } catch {
    return false; // misconfigured deployment fails closed (401), not 500
  }
  const header = req.headers.get("x-cron-secret");
  const auth = req.headers.get("authorization");
  return (
    (header !== null && safeEqual(header, secret)) ||
    (auth !== null && safeEqual(auth, `Bearer ${secret}`))
  );
}
