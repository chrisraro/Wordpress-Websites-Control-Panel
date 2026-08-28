import type { SupabaseClient } from "@supabase/supabase-js";
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
  failStaleAwaiting(olderThanMs: number): Promise<number>;
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
      const { error } = await db.from("jobs")
        .update({ status: "pending", last_error: err, scheduled_for: retryAtIso }).eq("id", id);
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
      const { error } = await db.from("jobs").update({ status: "awaiting_callback" }).eq("id", id);
      if (error) throw new Error(`jobs.markAwaiting failed: ${error.message}`, { cause: error });
    },
    async getJob(id) {
      const { data, error } = await db.from("jobs").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`jobs.getJob failed: ${error.message}`, { cause: error });
      return (data as JobRow) ?? null;
    },
    async failStaleAwaiting(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const { data, error } = await db.from("jobs")
        .update({ status: "failed", last_error: "Callback never arrived", finished_at: new Date().toISOString() })
        .eq("status", "awaiting_callback").lt("started_at", cutoff).select("id");
      if (error) throw new Error(`jobs.failStaleAwaiting failed: ${error.message}`, { cause: error });
      return (data ?? []).length;
    },
  };
}
