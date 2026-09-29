import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobStatus, JobType } from "@/services/jobs/types";
import { supabaseMaintenanceRepo, type MaintenanceRepo } from "@/services/maintenance/repo";
import { formatInZone } from "@/services/maintenance/window";

/**
 * Why a fleet run skipped a site that already has a live job of the same
 * type (JobsRepo.pendingExists), in words an operator can act on.
 *
 * The skip itself stays: two concurrent upgrader passes on one WordPress
 * install corrupt it. But a job held for a maintenance window can sit
 * pending for days, and "already queued from an earlier run" then reads like
 * a stuck queue. This says when the held job is scheduled (in the site's
 * window zone, else UTC), whether it is already running, and where to cancel
 * it -- only a pending job can be cancelled (JobsRepo.cancelBatch).
 */

/** The fields of a live job this needs. */
export interface LiveJob {
  id: string;
  status: JobStatus;
  scheduled_for: string;
  batch_id: string | null;
}

export interface HeldJobsDeps {
  /**
   * The site's live job of this type, with the same filters as
   * JobsRepo.pendingExists (status pending/running/awaiting_callback,
   * cancelled_at null); a running one if there is one, else the earliest.
   */
  liveJob(type: JobType, siteId: string): Promise<LiveJob | null>;
  /** The site's maintenance window, whose zone the time is shown in. */
  getWindow: MaintenanceRepo["getWindow"];
}

const LIVE_STATUSES: JobStatus[] = ["pending", "running", "awaiting_callback"];
/** Plenty to find a running one among; a site normally has one live job per type. */
const LIVE_JOB_SCAN = 5;
/** How many skipped sites a message names before "and N more". */
const MAX_NAMED = 3;
/** How many batch pages a message links. */
const MAX_BATCH_LINKS = 2;

/**
 * Service-role reads (jobs and the maintenance columns are both staff-only).
 * Lives here rather than on JobsRepo so the jobs service stays untouched.
 */
export function supabaseHeldJobsDeps(
  db: SupabaseClient, windows: Pick<MaintenanceRepo, "getWindow"> = supabaseMaintenanceRepo(db),
): HeldJobsDeps {
  return {
    async liveJob(type, siteId) {
      const { data, error } = await db.from("jobs")
        .select("id,status,scheduled_for,batch_id")
        .eq("type", type).eq("site_id", siteId)
        .in("status", LIVE_STATUSES)
        .is("cancelled_at", null)
        .order("scheduled_for", { ascending: true })
        .limit(LIVE_JOB_SCAN);
      if (error) throw new Error(`jobs.liveJob failed: ${error.message}`, { cause: error });
      const rows = (data ?? []) as LiveJob[];
      return rows.find((r) => r.status !== "pending") ?? rows[0] ?? null;
    },
    getWindow: (siteId) => windows.getWindow(siteId),
  };
}

/**
 * "already scheduled for Sat 3 Oct, 01:00 (Asia/Manila)" for a pending job
 * due in the future (UTC when the site has no window), "already running" for
 * one executing or awaiting its callback, "already queued" otherwise
 * (including a job that finished between the skip and this lookup).
 */
export function describeHeldJob(job: LiveJob | null, now: Date, timeZone: string | null): string {
  if (!job) return "already queued";
  if (job.status !== "pending") return "already running";
  const at = new Date(job.scheduled_for);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return "already queued";
  return timeZone
    ? `already scheduled for ${formatInZone(at, timeZone)} (${timeZone})`
    : `already scheduled for ${formatInZone(at, "UTC")} UTC`;
}

export interface HeldJobNote {
  siteName: string;
  /** describeHeldJob's text. */
  text: string;
  /** Pending, so it can be called off from its batch page. */
  cancellable: boolean;
  batchId: string | null;
}

export async function heldJobNote(
  deps: HeldJobsDeps, type: JobType, site: { id: string; name: string }, now: Date,
): Promise<HeldJobNote> {
  const job = await deps.liveJob(type, site.id);
  const window = job?.status === "pending" ? await deps.getWindow(site.id) : null;
  return {
    siteName: site.name,
    text: describeHeldJob(job, now, window?.timeZone ?? null),
    cancellable: job?.status === "pending",
    batchId: job?.batch_id ?? null,
  };
}

/**
 * "Acme already scheduled for Sat 3 Oct, 01:00 (Asia/Manila); Beta already
 * running. To run now instead, cancel the held run from its batch page:
 * /marketplace/batches/b1."
 */
export function heldJobsMessage(notes: HeldJobNote[]): string {
  const named = notes.slice(0, MAX_NAMED).map((n) => `${n.siteName} ${n.text}`);
  const more = notes.length > MAX_NAMED ? ` and ${notes.length - MAX_NAMED} more` : "";
  const batches = [...new Set(
    notes.filter((n) => n.cancellable && n.batchId).map((n) => n.batchId as string),
  )].slice(0, MAX_BATCH_LINKS);
  const hint = batches.length > 0
    ? `. To run now instead, cancel the held run from its batch page: ${
      batches.map((b) => `/marketplace/batches/${b}`).join(", ")}`
    : "";
  return `${named.join("; ")}${more}${hint}`;
}
