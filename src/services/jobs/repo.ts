import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceSupabase } from "@/lib/supabase/server";
import type { JobRow, JobType } from "./types";

export interface JobsRepo {
  insert(job: {
    type: JobType; site_id?: string | null;
    payload?: Record<string, unknown>; scheduled_for?: string; batch_id?: string | null;
  }): Promise<{ id: string }>;
  pendingExists(type: JobType, siteId: string | null): Promise<boolean>;
  claim(batchSize: number): Promise<JobRow[]>;
  markDone(id: string): Promise<void>;
  retry(id: string, error: string, retryAtIso: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  batchJobs(batchId: string): Promise<JobRow[]>;
  markAwaiting(id: string): Promise<void>;
  getJob(id: string): Promise<JobRow | null>;
  listStaleAwaiting(olderThanMs: number): Promise<JobRow[]>;
  /**
   * Site-less failures: `site_id IS NULL`, `status = 'failed'`,
   * `dismissed_at IS NULL`. These are jobs like `vuln_feed_refresh` that have
   * no site to attach to and so cannot appear in any per-site alert — this is
   * how the dashboard's system-health panel finds them.
   */
  listGlobalFailures(): Promise<JobRow[]>;
  /**
   * Clears the failed-runs alert for a site/type without touching the rows.
   * `siteId: null` is the global variant — jobs enqueued with no site
   * (`vuln_feed_refresh` today) — and filters on `site_id IS NULL` rather
   * than a value, matching `pendingExists`'s null handling above.
   */
  dismissFailed(siteId: string | null, type: JobType): Promise<void>;
}

export function supabaseJobsRepo(db: SupabaseClient): JobsRepo {
  return {
    async insert(job) {
      const { data, error } = await db.from("jobs").insert({
        type: job.type,
        site_id: job.site_id ?? null,
        payload: job.payload ?? {},
        ...(job.scheduled_for ? { scheduled_for: job.scheduled_for } : {}),
        ...(job.batch_id ? { batch_id: job.batch_id } : {}),
      }).select("id").single();
      if (error) throw new Error(`jobs.insert failed: ${error.message}`, { cause: error });
      return { id: data.id };
    },
    async pendingExists(type, siteId) {
      let q = db.from("jobs").select("id", { head: true, count: "exact" })
        .eq("type", type).eq("status", "pending");
      q = siteId === null ? q.is("site_id", null) : q.eq("site_id", siteId);
      const { count, error } = await q;
      if (error) throw new Error(`jobs.pendingExists failed: ${error.message}`, { cause: error });
      return (count ?? 0) > 0;
    },
    async claim(batchSize) {
      const { data, error } = await db.rpc("claim_jobs", { batch_size: batchSize });
      if (error) throw new Error(`claim_jobs failed: ${error.message}`, { cause: error });
      return (data ?? []) as JobRow[];
    },
    async markDone(id) {
      const { error } = await db.from("jobs")
        .update({ status: "done", finished_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(`jobs.markDone failed: ${error.message}`, { cause: error });
    },
    async retry(id, err, retryAtIso) {
      // Clears any prior dismissal: `failed` is terminal today so this path
      // isn't reachable for a dismissed job yet, but a future `failed ->
      // pending` retry path must not resurrect a job that was born dismissed
      // — a job back on the ladder should reappear in the failed-runs alert
      // if it fails again.
      const { error } = await db.from("jobs")
        .update({ status: "pending", last_error: err, scheduled_for: retryAtIso, dismissed_at: null })
        .eq("id", id);
      if (error) throw new Error(`jobs.retry failed: ${error.message}`, { cause: error });
    },
    async markFailed(id, err) {
      const { error } = await db.from("jobs")
        .update({ status: "failed", last_error: err, finished_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error(`jobs.markFailed failed: ${error.message}`, { cause: error });
    },
    async batchJobs(batchId) {
      const { data, error } = await db.from("jobs").select("*")
        .eq("batch_id", batchId).order("scheduled_for");
      if (error) throw new Error(`jobs.batchJobs failed: ${error.message}`, { cause: error });
      return (data ?? []) as JobRow[];
    },
    async markAwaiting(id) {
      // Only park a job that is still running: a fast callback may already have
      // completed it, and parking would resurrect a finished job.
      const { error } = await db.from("jobs").update({ status: "awaiting_callback" })
        .eq("id", id).eq("status", "running");
      if (error) throw new Error(`jobs.markAwaiting failed: ${error.message}`, { cause: error });
    },
    async getJob(id) {
      const { data, error } = await db.from("jobs").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`jobs.getJob failed: ${error.message}`, { cause: error });
      return (data as JobRow) ?? null;
    },
    async listStaleAwaiting(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const { data, error } = await db.from("jobs").select("*")
        .eq("status", "awaiting_callback").lt("started_at", cutoff);
      if (error) throw new Error(`jobs.listStaleAwaiting failed: ${error.message}`, { cause: error });
      return (data ?? []) as JobRow[];
    },
    async listGlobalFailures() {
      const { data, error } = await db.from("jobs").select("*")
        .is("site_id", null).eq("status", "failed").is("dismissed_at", null)
        .order("scheduled_for", { ascending: false });
      if (error) throw new Error(`jobs.listGlobalFailures failed: ${error.message}`, { cause: error });
      return (data ?? []) as JobRow[];
    },
    async dismissFailed(siteId, type) {
      // jobs has RLS enabled with no write policy at all (0008_rls_scoped.sql:
      // "every legitimate enqueue goes through enqueueJob() on the
      // service-role client, which bypasses RLS entirely... A write policy
      // here would open a client-side path to enqueue arbitrary jobs"). Every
      // other write in this file relies on its caller having already passed a
      // service-role `db` — true today, but this method is reachable from a
      // page-read call site too (the GeoGrid page builds its JobsRepo off
      // `readDbFor(viewer)`, which is user-scoped for clients). Rather than
      // depend on every future caller getting that right, this one write
      // constructs its own service-role client, so dismissing an alert works
      // (or fails loudly with a thrown error) regardless of which `db` this
      // factory happened to be built with.
      const service = createServiceSupabase();
      let q = service.from("jobs")
        .update({ dismissed_at: new Date().toISOString() })
        .eq("type", type).eq("status", "failed").is("dismissed_at", null);
      // Mirrors pendingExists's null handling above: `.eq("site_id", null)`
      // matches nothing in Postgres (NULL is never equal to NULL), so the
      // global variant needs `.is()` instead or dismissal would silently
      // no-op for every site-less job.
      q = siteId === null ? q.is("site_id", null) : q.eq("site_id", siteId);
      const { error } = await q;
      if (error) throw new Error(`jobs.dismissFailed failed: ${error.message}`, { cause: error });
    },
  };
}
