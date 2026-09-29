import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow } from "./types";
import { canAccessSite, type Viewer } from "@/lib/authz/decide";

/**
 * A batch's jobs can span many sites (an install fans one item out across
 * the fleet), and holding `queue.process` says nothing about which of those
 * sites the caller may act on. Every batch-wide operator action therefore
 * narrows to jobs on sites the viewer can *manage* -- cancelling or re-running
 * work is a write on that site -- before touching anything. Jobs with no
 * site are never included: nothing grants access to them per-site.
 */
export function manageableBatchJobs(viewer: Viewer, jobs: JobRow[]): JobRow[] {
  return jobs.filter((j) => j.site_id !== null && canAccessSite(viewer, j.site_id, "manage"));
}

/** Pending, not-yet-cancelled jobs -- the only ones a cancel can reach. */
export function cancellableIds(jobs: JobRow[]): string[] {
  return jobs.filter((j) => j.status === "pending" && !j.cancelled_at).map((j) => j.id);
}

/** Failed jobs -- the only ones a retry puts back on the queue. */
export function retryableIds(jobs: JobRow[]): string[] {
  return jobs.filter((j) => j.status === "failed").map((j) => j.id);
}

/**
 * Puts exactly the given jobs back on the queue, if each is still failed.
 * The id-scoped twin of JobsRepo#retryFailedInBatch (same update, same
 * "attempts left alone" rule), for the same reason JobsRepo#cancelJobs
 * exists beside cancelBatch: what gets retried must never exceed what the
 * caller is allowed to act on. Returns 0 without a query for no ids.
 */
export async function retryFailedJobs(db: SupabaseClient, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await db.from("jobs")
    .update({
      status: "pending",
      scheduled_for: new Date().toISOString(),
      cancelled_at: null,
      dismissed_at: null,
    })
    .in("id", ids)
    .eq("status", "failed")
    .select("id");
  if (error) throw new Error(`jobs.retryFailedJobs failed: ${error.message}`, { cause: error });
  return (data ?? []).length;
}
