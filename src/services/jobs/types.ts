export type JobType =
  // "plugin_install" also carries theme installs — see payload.target in
  // src/services/jobs/handlers.ts ("theme" | "plugin", omitted = plugin).
  // Any query that filters on this type (e.g. `WHERE type = 'plugin_install'`)
  // must unpack that field to tell plugins and themes apart.
  | "snapshot_refresh" | "security_scan" | "vuln_feed_refresh"
  | "plugin_install" | "seo_scan" | "geogrid_run" | "report_generate"
  | "bulk_manage";
export type JobStatus = "pending" | "running" | "awaiting_callback" | "done" | "failed";

export interface JobRow {
  id: string;
  type: JobType;
  site_id: string | null;
  batch_id: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  scheduled_for: string;
  last_error: string | null;
  /**
   * Stamped by JobsRepo.markDone and JobsRepo.markFailed; null until the job
   * finishes one way or the other. Was already written to every row (see
   * both call sites) but never read from TypeScript until the dashboard's
   * system-health panel needed an honest "when it failed" rather than
   * reusing `scheduled_for`, which moves on every retry.
   */
  finished_at: string | null;
  /**
   * Requires migration 0015 (`alter table jobs add column dismissed_at`).
   * Written by JobsRepo.retry (cleared to null) and JobsRepo.dismissFailed
   * (set); read by dismissFailed's `.is("dismissed_at", null)` filter and by
   * the GeoGrid page's `select`. All three are untyped — and, against a
   * pre-0015 schema, broken — without this field.
   */
  dismissed_at: string | null;
}

/**
 * Human labels for the dashboard's system-health panel, which shows the raw
 * `type` of any site-less job that has failed. Kept exhaustive over
 * `JobType` (rather than a fallback string) so a new job type that starts
 * being enqueued with `site_id: null` fails to compile here instead of
 * rendering its raw snake_case name.
 */
export const JOB_TYPE_LABEL: Record<JobType, string> = {
  snapshot_refresh: "Inventory refresh",
  security_scan: "Security scan",
  vuln_feed_refresh: "Vulnerability feed refresh",
  plugin_install: "Plugin/theme install",
  seo_scan: "SEO scan",
  geogrid_run: "GeoGrid run",
  report_generate: "Report generation",
  bulk_manage: "Bulk action",
};
