/**
 * Alerting: the panel decides *what* needs attention and POSTs it to an n8n
 * workflow, which sends the email. See docs/ops/alerts.md.
 */

export const ALERT_KINDS = [
  "site_down",
  "site_recovered",
  "ssl_expiring",
  "critical_vulnerability",
  "jobs_failed",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** activity_log.action for every row the alert sender writes (the dedupe ledger). */
export const ALERT_ACTION = "alert.sent";

/**
 * activity_log.actor is `uuid not null` with no foreign key; alert rows are
 * written by the scheduler, not a person, so they carry the nil UUID.
 */
export const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

export interface Alert {
  kind: AlertKind;
  site_id: string | null;
  /** Site display name, or null for fleet-wide alerts (e.g. a failed feed refresh). */
  site: string | null;
  message: string;
  /** Dedupe keys; one activity_log row is written per key once the alert is sent. */
  keys: string[];
}

export interface AlertSite {
  id: string;
  name: string;
  status: string;
}

export interface UptimeSample {
  site_id: string;
  ok: boolean;
  checked_at: string;
  http_status: number | null;
  ssl_days_remaining: number | null;
}

export interface VulnCandidate {
  id: string;
  site_id: string;
  component: string;
  installed_version: string;
  severity: string | null;
  cvss: number | null;
  title: string | null;
  cve: string | null;
  first_seen: string;
  status: string;
}

export interface FailedJob {
  id: string;
  site_id: string | null;
  type: string;
  finished_at: string | null;
  last_error: string | null;
  dismissed_at: string | null;
}

/** A previous `alert.sent` activity_log row. */
export interface AlertHistoryRow {
  site_id: string | null;
  kind: AlertKind;
  key: string;
  at: string;
}

/** Everything the pure evaluator needs; loaded from the DB by repo.ts. */
export interface AlertState {
  now: Date;
  appUrl: string | null;
  sites: AlertSite[];
  uptime: UptimeSample[];
  vulns: VulnCandidate[];
  failedJobs: FailedJob[];
  history: AlertHistoryRow[];
}

export interface AlertPayload {
  subject: string;
  text: string;
  alerts: Array<{ kind: AlertKind; site: string | null; message: string }>;
  dry_run: boolean;
}
