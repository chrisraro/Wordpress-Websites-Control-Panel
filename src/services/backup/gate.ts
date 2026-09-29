import type { McpFactory } from "@/lib/mcp/client";
import { connectToSite } from "@/lib/mcp/connect";
import type { SitesRepo } from "@/services/sites/repo";
import { DeferJob, NonRetryableError } from "@/services/jobs/service";
import {
  BACKUP_POLL_MS, decideBackup, readBackupStatus, requestBackup,
  type BackupDecision, type BackupPolicy,
} from "./updraft";

export interface BackupGateDeps {
  sites: Pick<SitesRepo, "getSiteCredentials">;
  mcp: McpFactory;
  /**
   * The newest backup_requested_at among this site's other live update jobs
   * (within the timeout), so the jobs of one bulk action share one backup
   * instead of each asking for its own. Optional: without it each job
   * tracks its own request.
   */
  siteBackupRequestedAt?: (siteId: string) => Promise<number | null>;
}

/** What an update job carries about its pre-update backup. */
export interface BackupJobFields {
  /** "skip" = the operator chose "update without a backup". Absent = required. */
  backup?: BackupPolicy;
  /** Epoch ms when this job asked the site for a backup (set on deferral). */
  backup_requested_at?: number;
}

export function backupPolicyOf(payload: BackupJobFields): BackupPolicy {
  return payload.backup === "skip" ? "skip" : "required";
}

async function liveDecision(
  deps: BackupGateDeps, siteId: string, policy: BackupPolicy, now: number, requestedAt?: number,
): Promise<{ decision: BackupDecision; request: () => Promise<boolean> }> {
  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) throw new NonRetryableError("Site not found");
  const client = await connectToSite(deps.mcp, creds);
  try {
    const status = await readBackupStatus(client);
    const decision = decideBackup({ policy, status, now, requestedAt });
    return {
      decision,
      request: async () => {
        const c = await connectToSite(deps.mcp, creds);
        try { return await requestBackup(c); } finally { await c.close(); }
      },
    };
  } finally {
    await client.close();
  }
}

/**
 * Runs before an update job touches the site. Returns when the update may
 * go ahead; otherwise throws: DeferJob to wait for a backup (the job comes
 * back in BACKUP_POLL_MS without spending an attempt), NonRetryableError
 * when the update must not run (no backup plugin, backup failed or overdue),
 * or a plain error (site unreachable) for the normal retry ladder.
 */
export async function gateOnBackup(
  deps: BackupGateDeps, siteId: string, payload: BackupJobFields, now: number = Date.now(),
): Promise<void> {
  const policy = backupPolicyOf(payload);
  if (policy === "skip") return;
  const own = typeof payload.backup_requested_at === "number" ? payload.backup_requested_at : undefined;
  const sibling = own === undefined && deps.siteBackupRequestedAt
    ? (await deps.siteBackupRequestedAt(siteId)) ?? undefined
    : undefined;
  const requestedAt = own ?? sibling;
  const { decision, request } = await liveDecision(deps, siteId, policy, now, requestedAt);
  switch (decision.kind) {
    case "proceed":
      return;
    case "request":
      // false = WP-Cron already holds an identical event: that is the backup
      // to wait for, so wait either way.
      await request();
      throw new DeferJob(BACKUP_POLL_MS, "Waiting for the pre-update backup to finish", { backup_requested_at: now });
    case "wait":
      // Always record a marker, so the 60-minute timeout bounds a job that
      // adopted a sibling's (or UpdraftPlus's own) backup too.
      throw new DeferJob(BACKUP_POLL_MS, "Waiting for the pre-update backup to finish",
        { backup_requested_at: requestedAt ?? now });
    case "fail":
      throw new NonRetryableError(decision.reason);
  }
}

/**
 * For inline updates (the core update button), which cannot wait: is there
 * a fresh successful backup right now? Never requests one.
 */
export async function backupReadyForInlineUpdate(
  deps: BackupGateDeps, siteId: string, now: number = Date.now(),
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const { decision } = await liveDecision(deps, siteId, "required", now);
  if (decision.kind === "proceed") return { ready: true };
  if (decision.kind === "fail") return { ready: false, reason: decision.reason };
  return {
    ready: false,
    reason: "No successful backup in the last 6 hours. Start a backup and update once it finishes, "
      + "or update without a backup.",
  };
}

/** Starts a backup on the site now (the "Back up now" button). */
export async function startBackup(deps: BackupGateDeps, siteId: string): Promise<void> {
  const { request } = await liveDecision(deps, siteId, "required", Date.now());
  await request(); // false = one is already queued, which is what was asked for
}
