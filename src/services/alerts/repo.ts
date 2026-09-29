import type { SupabaseClient } from "@supabase/supabase-js";
import { JOB_WINDOW_MS, VULN_WINDOW_MS } from "./evaluate";
import {
  ALERT_ACTION,
  ALERT_KINDS,
  SYSTEM_ACTOR,
  type Alert,
  type AlertHistoryRow,
  type AlertKind,
  type AlertSite,
  type AlertState,
  type FailedJob,
  type UptimeSample,
  type VulnCandidate,
} from "./types";

export type LoadedAlertState = Omit<AlertState, "now" | "appUrl">;

export interface AlertsRepo {
  loadState(now: Date): Promise<LoadedAlertState>;
  /** One `alert.sent` activity_log row per dedupe key of every alert. */
  recordSent(alerts: Alert[]): Promise<void>;
}

/**
 * Covers every dedupe window: SSL repeats after 24h, jobs alert within 24h
 * of failing, vulnerabilities within 7 days of first being seen -- so any
 * alert that could suppress one of those was written less than 8 days ago.
 * Up/down state is read separately, per site, with no time limit: an
 * incident can stay open for weeks.
 */
const HISTORY_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

type Result = { data: unknown; error: { message: string } | null };
type Paged = { range(from: number, to: number): PromiseLike<Result> };

/** PostgREST caps a response at 1000 rows; read page by page until a short page. */
async function allRows<T>(label: string, query: () => Paged): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await query().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`alerts: ${label} query failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

function check<T>(label: string, r: Result): T {
  if (r.error) throw new Error(`alerts: ${label} query failed: ${r.error.message}`);
  return (r.data ?? []) as T;
}

type HistoryDbRow = { site_id: string | null; at: string; detail: unknown };

function toHistory(r: HistoryDbRow): AlertHistoryRow | null {
  const d = r.detail as { kind?: unknown; key?: unknown } | null;
  if (!d || typeof d.key !== "string" || !ALERT_KINDS.includes(d.kind as AlertKind)) return null;
  return { site_id: r.site_id, kind: d.kind as AlertKind, key: d.key, at: r.at };
}

type VulnDbRow = Omit<VulnCandidate, "cvss" | "title" | "cve"> & {
  vuln_feed: { cvss: number | string | null; title: string | null; cve: string | null }
    | Array<{ cvss: number | string | null; title: string | null; cve: string | null }> | null;
};

function toVuln(r: VulnDbRow): VulnCandidate {
  const feed = Array.isArray(r.vuln_feed) ? r.vuln_feed[0] : r.vuln_feed;
  // numeric columns can arrive as strings from PostgREST.
  const cvss = feed?.cvss === null || feed?.cvss === undefined ? null : Number(feed.cvss);
  return {
    id: r.id, site_id: r.site_id, component: r.component, installed_version: r.installed_version,
    severity: r.severity, status: r.status, first_seen: r.first_seen,
    cvss: Number.isFinite(cvss) ? cvss : null, title: feed?.title ?? null, cve: feed?.cve ?? null,
  };
}

/** Service-role reads/writes for alerting. Never selects credential columns. */
export function supabaseAlertsRepo(db: SupabaseClient): AlertsRepo {
  return {
    async loadState(now) {
      const since = (ms: number) => new Date(now.getTime() - ms).toISOString();

      const sites = check<AlertSite[]>("sites", await db.from("sites").select("id,name,status"));
      const active = sites.filter((s) => s.status !== "disabled");

      const perSite = await Promise.all(active.map(async (s) => {
        const [uptime, lastState] = await Promise.all([
          db.from("uptime_checks")
            .select("site_id,ok,checked_at,http_status,ssl_days_remaining")
            .eq("site_id", s.id)
            .order("checked_at", { ascending: false })
            .limit(2),
          db.from("activity_log")
            .select("site_id,at,detail")
            .eq("site_id", s.id)
            .eq("action", ALERT_ACTION)
            .in("detail->>kind", ["site_down", "site_recovered"])
            .order("at", { ascending: false })
            .limit(1),
        ]);
        return {
          uptime: check<UptimeSample[]>("uptime_checks", uptime as Result),
          lastState: check<HistoryDbRow[]>("activity_log", lastState as Result),
        };
      }));

      const [vulns, failedJobs, recent] = await Promise.all([
        allRows<VulnDbRow>("site_vulnerabilities", () => db.from("site_vulnerabilities")
          .select("id,site_id,component,installed_version,severity,status,first_seen,vuln_feed(cvss,title,cve)")
          .eq("status", "open")
          .gte("first_seen", since(VULN_WINDOW_MS))
          .order("first_seen", { ascending: false })),
        allRows<FailedJob>("jobs", () => db.from("jobs")
          .select("id,site_id,type,finished_at,last_error,dismissed_at")
          .eq("status", "failed")
          .is("dismissed_at", null)
          .gte("finished_at", since(JOB_WINDOW_MS))
          .order("finished_at", { ascending: false })),
        allRows<HistoryDbRow>("activity_log", () => db.from("activity_log")
          .select("site_id,at,detail")
          .eq("action", ALERT_ACTION)
          .gte("at", since(HISTORY_LOOKBACK_MS))
          .order("at", { ascending: false })),
      ]);

      const history = [...perSite.flatMap((p) => p.lastState), ...recent]
        .map(toHistory)
        .filter((h): h is AlertHistoryRow => h !== null);

      return {
        sites,
        uptime: perSite.flatMap((p) => p.uptime),
        vulns: vulns.map(toVuln),
        failedJobs,
        history,
      };
    },

    async recordSent(alerts) {
      const rows = alerts.flatMap((a) => a.keys.map((key) => ({
        actor: SYSTEM_ACTOR,
        site_id: a.site_id,
        action: ALERT_ACTION,
        detail: { kind: a.kind, key },
      })));
      if (rows.length === 0) return;
      const { error } = await db.from("activity_log").insert(rows);
      if (error) throw new Error(`alerts: recording sent alerts failed: ${error.message}`);
    },
  };
}
