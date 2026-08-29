export type JobType =
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
}
