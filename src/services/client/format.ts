import type { BackupStatus } from "@/services/inventory/types";
import type { ReportRow } from "@/services/reports/repo";
import { shareLinkState } from "@/services/reports/share";

/**
 * The evidence lines on a client's home screen, as pure functions.
 *
 * Every function here answers one question a customer might ask -- "is it
 * up?", "is it secure?", "is it backed up?", "is anyone doing anything?" --
 * and returns null when the honest answer is "we don't know". Null means the
 * line is left off the card entirely. PRODUCT.md principle 4 ("empty,
 * unmeasured, failed and stale are different states") is the rule each of
 * them is tested against: a failed read is not "not measured", "not
 * measured" is not 100%, and a backup tool we can't see is not "no backups".
 *
 * Nothing here may name the mechanism (a plugin, a table, a job). The words
 * are the agency's promise to a customer, not a readout of the console.
 */

const DAY_MS = 86_400_000;

/** The window the uptime figure covers. uptime_checks keeps 90 days (0025). */
export const UPTIME_WINDOW_DAYS = 30;
/** Below this, uptime is shown as a warning rather than a reassurance. */
const UPTIME_GOOD_PERCENT = 99;
/** Same line the staff SSL alert draws (SSL_THRESHOLD_DAYS in alerts/evaluate.ts). */
const SSL_RENEWS_SOON_DAYS = 14;
/** An SSL reading older than this is not stood behind on a client screen. */
const SSL_MAX_AGE_DAYS = 30;
/** A backup older than this is not "recent". */
const BACKUP_RECENT_DAYS = 7;

export type EvidenceTone = "good" | "warn" | "bad" | "idle";

export interface EvidenceItem {
  label: string;
  value: string;
  detail?: string;
  tone: EvidenceTone;
}

export interface UptimeTally {
  /** Checks in the window. 0 = never measured in it. */
  total: number;
  ok: number;
  /** The earliest check in the window, so a young site isn't credited with 30 days. */
  firstIso: string | null;
}

export interface SslReading {
  /** Whole days left on the certificate when it was checked (negative once lapsed). */
  days: number;
  checkedAtIso: string;
}

export type LatestReport = Pick<ReportRow, "share_token" | "share_expires_at" | "period_end" | "generated_at">;

/** "2 days ago" beats a raw locale timestamp for a once-a-month visitor. */
export function relativeDays(iso: string, now: number): string {
  const days = Math.floor((now - new Date(iso).getTime()) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "last month" : `${months} months ago`;
}

/**
 * The first instant of the current calendar month, in UTC -- the same clock
 * every other date in this system (pg_cron, report periods) runs on.
 */
export function monthStartIso(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * Integer arithmetic, floored: one failed check in a month must never round
 * up to "100%". 100% is shown only when every single check passed.
 */
function percent(ok: number, total: number): string {
  if (ok >= total) return "100%";
  const hundredths = Math.floor((ok * 10_000) / total);
  return `${String(hundredths / 100)}%`;
}

export function uptimeItem(tally: UptimeTally | null, now: number): EvidenceItem | null {
  if (!tally) return null;
  if (tally.total === 0) {
    return { label: "Uptime", value: "Not measured yet", tone: "idle" };
  }
  const covered = tally.firstIso !== null
    && now - Date.parse(tally.firstIso) >= (UPTIME_WINDOW_DAYS - 1) * DAY_MS;
  const detail = covered || tally.firstIso === null
    ? `Last ${UPTIME_WINDOW_DAYS} days`
    : `Since checks began ${relativeDays(tally.firstIso, now)}`;
  const tone = (tally.ok * 100) / tally.total >= UPTIME_GOOD_PERCENT ? "good" : "warn";
  return { label: "Uptime", value: percent(tally.ok, tally.total), detail, tone };
}

export function sslItem(reading: SslReading | null, now: number): EvidenceItem | null {
  if (!reading) return null;
  const ageDays = Math.floor((now - Date.parse(reading.checkedAtIso)) / DAY_MS);
  if (!Number.isFinite(ageDays) || ageDays > SSL_MAX_AGE_DAYS) return null;
  // The reading counts down from when it was taken, not from now.
  const days = reading.days - Math.max(0, ageDays);
  const label = "Secure connection (SSL)";
  if (days < 0) return { label, value: "Expired", tone: "bad" };
  if (days < SSL_RENEWS_SOON_DAYS) return { label, value: "Renews soon", tone: "warn" };
  return { label, value: `Valid for ${days} more days`, tone: "good" };
}

export function backupItem(backup: BackupStatus | null | undefined, now: number): EvidenceItem | null {
  // undefined: a snapshot from before backups were measured. null: no
  // supported backup tool is active -- the site may well be backed up some
  // other way (the host, for one), so this is "unknown", not "none".
  if (!backup) return null;
  const label = "Backups";
  const noRecent: EvidenceItem = { label, value: "No recent backup", tone: "warn" };
  if (backup.last_backup_time === null) return noRecent;
  // A run that failed is not a backup; one whose outcome was never recorded
  // is not a claim this screen can make either way.
  if (backup.success === false) return noRecent;
  if (backup.success !== true) return null;
  const whenIso = new Date(backup.last_backup_time * 1000).toISOString();
  if (now - Date.parse(whenIso) > BACKUP_RECENT_DAYS * DAY_MS) return noRecent;
  return { label, value: `Backed up ${relativeDays(whenIso, now)}`, tone: "good" };
}

/**
 * @param completed maintenance actions that succeeded this month; null = unknown.
 * @param lastCheckedIso when the site was last checked; a zero only means
 *   "nothing was needed" if someone actually looked this month.
 */
export function careItem(
  completed: number | null, lastCheckedIso: string | null, now: number,
): EvidenceItem | null {
  if (completed === null) return null;
  const label = "Care this month";
  if (completed > 0) {
    const noun = completed === 1 ? "maintenance update" : "maintenance updates";
    return { label, value: `${completed} ${noun} this month`, tone: "good" };
  }
  const checkedThisMonth = lastCheckedIso !== null && lastCheckedIso >= monthStartIso(now);
  return checkedThisMonth ? { label, value: "No changes needed this month", tone: "good" } : null;
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * The card's one action. The newest report's own share page when its link
 * still opens -- the thing a client can read and forward -- otherwise the
 * site's reports list, which is always there.
 */
export function reportLink(
  siteId: string, latest: LatestReport | null, now: number,
): { href: string; label: string } {
  if (latest?.share_token && shareLinkState(latest, now) === "active") {
    const month = MONTH.format(new Date(latest.period_end ?? latest.generated_at));
    return { href: `/r/${latest.share_token}`, label: `Latest report · ${month}` };
  }
  return { href: `/sites/${siteId}/reports`, label: "Reports for this site" };
}
