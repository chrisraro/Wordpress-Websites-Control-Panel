import type { BackupStatus } from "@/services/inventory/types";
import { BACKUP_FRESH_MS } from "./updraft";

export type BackupTone = "good" | "warn" | "bad" | "idle";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

function relative(ms: number): string {
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour");
  return plural(Math.floor(ms / DAY), "day");
}

/**
 * The site page's "Last backup" line, from the latest inventory snapshot.
 *
 * `undefined` is "not measured" (a snapshot from before the field existed)
 * and returns null so the page shows nothing rather than a false "none";
 * `null` is "measured, no supported backup plugin". A successful backup
 * inside the pre-update window (BACKUP_FRESH_MS) is "good" -- an update
 * would use it as-is -- and an older one "idle": fine, but an update will
 * take a new one first.
 */
export function describeLastBackup(
  backup: BackupStatus | null | undefined, now: number = Date.now(),
): { text: string; tone: BackupTone } | null {
  if (backup === undefined) return null;
  if (backup === null) return { text: "No backup plugin", tone: "warn" };
  if (backup.success === false) return { text: "Last backup failed", tone: "bad" };
  if (backup.last_backup_time === null) return { text: "None yet (UpdraftPlus)", tone: "warn" };
  const age = Math.max(0, now - backup.last_backup_time * 1000);
  return {
    text: `${relative(age)} (UpdraftPlus)`,
    tone: age <= BACKUP_FRESH_MS ? "good" : "idle",
  };
}
