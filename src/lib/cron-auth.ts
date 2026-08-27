import { getEnv } from "@/lib/env";

export function isAuthorizedCronRequest(req: Request): boolean {
  const secret = getEnv("CRON_SECRET");
  const header = req.headers.get("x-cron-secret");
  const auth = req.headers.get("authorization");
  return header === secret || auth === `Bearer ${secret}`;
}
