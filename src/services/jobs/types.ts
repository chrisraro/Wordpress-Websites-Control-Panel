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
}
