import type { BackupPolicy } from "./updraft";

/**
 * "Back up first" vs "Update without a backup", as it travels from a form or
 * a tool argument onto a queued update job (read back by gateOnBackup).
 *
 * The safe answer is the default: only the literal "skip" turns the backup
 * off, so a tampered or missing value can only ever keep the backup, never
 * silently drop it -- the mirror of parseTiming, where a bad value can only
 * make work run sooner under the operator's eyes.
 */
export function parseBackupChoice(fd: FormData | undefined | null): BackupPolicy {
  return fd?.get("backup") === "skip" ? "skip" : "required";
}

/**
 * The job-payload fields for a policy. "required" adds nothing -- an absent
 * `backup` field already means required (backupPolicyOf) -- so a default
 * enqueue produces exactly the payload it always has.
 */
export function backupPayload(policy: BackupPolicy | undefined): { backup?: "skip" } {
  return policy === "skip" ? { backup: "skip" } : {};
}
