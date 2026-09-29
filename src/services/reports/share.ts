import { randomBytes } from "node:crypto";
import type { ReportRow, ReportsRepo } from "./repo";

/**
 * How long a share link works. A report link is a bearer credential with no
 * login behind it, so it should not outlive the conversation it was sent in;
 * a month covers "the client opens it next week" with room to spare.
 */
export const SHARE_LINK_TTL_DAYS = 30;
const SHARE_LINK_TTL_MS = SHARE_LINK_TTL_DAYS * 24 * 3600 * 1000;

export function newShareToken(): string {
  return randomBytes(16).toString("hex");
}

export function shareLinkExpiry(now: number = Date.now()): string {
  return new Date(now + SHARE_LINK_TTL_MS).toISOString();
}

export type ShareLinkState = "active" | "expired" | "none";

/**
 * - none: no token -- a monthly report nobody shared yet, or a revoked link.
 * - expired: the token exists but its expiry has passed (it no longer opens).
 * - active: opens. A null expiry is a link minted before expiry existed;
 *   those are deliberately left valid (README, "Reports").
 */
export function shareLinkState(
  row: Pick<ReportRow, "share_token" | "share_expires_at">, now: number = Date.now(),
): ShareLinkState {
  if (!row.share_token) return "none";
  if (row.share_expires_at && Date.parse(row.share_expires_at) <= now) return "expired";
  return "active";
}

/**
 * Mints a fresh link for an existing report: a new token, never the old one,
 * so a revoked or expired link stays dead. Scoped by site id as well as
 * report id (see ReportsRepo.setShareLink).
 */
export async function createShareLink(
  repo: ReportsRepo, reportId: string, siteId: string, now: number = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const token = newShareToken();
  const expiresAt = shareLinkExpiry(now);
  await repo.setShareLink(reportId, siteId, token, expiresAt);
  return { token, expiresAt };
}
