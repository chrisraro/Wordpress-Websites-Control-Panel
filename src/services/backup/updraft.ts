import type { SiteMcpClient } from "@/lib/mcp/client";
import { runPhp } from "@/lib/wpphp";

/**
 * Pre-update backups through the site's own UpdraftPlus.
 *
 * The panel never takes a backup itself: shared hosting and serverless time
 * limits rule that out. It asks UpdraftPlus to run one (scheduled on
 * WP-Cron, so the request returns at once and the backup runs in the site's
 * own PHP), then checks back until UpdraftPlus records a finished run newer
 * than the request. The update job waits by deferring itself, not by holding
 * a function open.
 */

/** A successful backup this recent counts as "taken before the update". */
export const BACKUP_FRESH_MS = 6 * 3600_000;
/** How long a requested backup may take before the update is abandoned. */
export const BACKUP_TIMEOUT_MS = 60 * 60_000;
/** How long an update job waits between checks on a requested backup. */
export const BACKUP_POLL_MS = 2 * 60_000;

export type BackupPolicy = "required" | "skip";

export interface LiveBackupStatus {
  plugin: "updraftplus" | null;
  last_backup_time: number | null;
  success: boolean | null;
  /** A backup is queued on WP-Cron and has not started or finished. */
  pending: boolean;
}

export type BackupDecision =
  | { kind: "proceed" }
  | { kind: "request" }
  | { kind: "wait" }
  | { kind: "fail"; reason: string };

export function decideBackup(input: {
  policy: BackupPolicy; status: LiveBackupStatus | null; now: number; requestedAt?: number;
}): BackupDecision {
  const { policy, status, now, requestedAt } = input;
  if (policy === "skip") return { kind: "proceed" };
  if (!status || status.plugin === null) {
    return {
      kind: "fail",
      reason: "No supported backup plugin is active on this site (UpdraftPlus is needed for a "
        + "pre-update backup). Install it, or re-run the update without a backup.",
    };
  }
  const lastMs = status.last_backup_time === null ? null : status.last_backup_time * 1000;
  const fresh = lastMs !== null && status.success === true && now - lastMs <= BACKUP_FRESH_MS;
  const overdue = requestedAt !== undefined && now - requestedAt > BACKUP_TIMEOUT_MS;
  const OVERDUE = { kind: "fail", reason: "The pre-update backup did not finish within 60 minutes; the update was not run." } as const;

  // A backup queued on WP-Cron is ours or a sibling job's: wait for it,
  // never queue a second one (several update jobs for one site arrive
  // together from a bulk action).
  if (status.pending) return overdue ? OVERDUE : { kind: "wait" };
  if (fresh) return { kind: "proceed" };
  if (requestedAt === undefined) return { kind: "request" };

  // UpdraftPlus records its start time; a finished run from around the
  // request (or later) that failed is this update's backup failing.
  if (lastMs !== null && lastMs >= requestedAt - 5 * 60_000 && status.success === false) {
    return { kind: "fail", reason: "The pre-update backup finished with errors; the update was not run. Check UpdraftPlus on the site." };
  }
  // Requested and no longer queued: it is running (or WP-Cron has not
  // spawned it yet). Wait, up to the timeout.
  return overdue ? OVERDUE : { kind: "wait" };
}

export const BACKUP_STATUS_PHP = `
if (!class_exists('UpdraftPlus')) {
  return json_encode(array('plugin' => null, 'last_backup_time' => null, 'success' => null, 'pending' => false));
}
$lb = get_option('updraft_last_backup');
$pending = false;
$crons = function_exists('_get_cron_array') ? _get_cron_array() : array();
if (is_array($crons)) {
  foreach ($crons as $hooks) {
    if (is_array($hooks) && isset($hooks['updraft_backupnow_backup_all'])) { $pending = true; break; }
  }
}
return json_encode(array(
  'plugin' => 'updraftplus',
  'last_backup_time' => (is_array($lb) && isset($lb['backup_time'])) ? (int) $lb['backup_time'] : null,
  'success' => (is_array($lb) && isset($lb['success'])) ? (bool) $lb['success'] : null,
  'pending' => $pending,
));
`.trim();

export const REQUEST_BACKUP_PHP = `
if (!class_exists('UpdraftPlus')) { return json_encode(array('ok' => false, 'error' => 'UpdraftPlus is not active')); }
$scheduled = wp_schedule_single_event(time(), 'updraft_backupnow_backup_all', array(array('nocloud' => 0)));
if (function_exists('spawn_cron')) { spawn_cron(); }
return json_encode(array('ok' => $scheduled !== false, 'time' => time()));
`.trim();

export async function readBackupStatus(client: SiteMcpClient): Promise<LiveBackupStatus> {
  return runPhp<LiveBackupStatus>(client, BACKUP_STATUS_PHP, 30_000);
}

/**
 * Queues a backup. `false` means WP-Cron refused the event -- in practice
 * because an identical one is already queued, which is the backup this
 * update would have waited for anyway -- so the caller waits either way.
 * Throws only when UpdraftPlus is not active.
 */
export async function requestBackup(client: SiteMcpClient): Promise<boolean> {
  const res = await runPhp<{ ok: boolean; error?: string }>(client, REQUEST_BACKUP_PHP, 30_000);
  if (res.error) throw new Error(`Could not start the pre-update backup: ${res.error}`);
  return res.ok;
}
