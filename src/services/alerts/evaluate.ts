import {
  ALERT_KINDS,
  type Alert,
  type AlertHistoryRow,
  type AlertSite,
  type AlertState,
  type FailedJob,
  type UptimeSample,
  type VulnCandidate,
} from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A certificate with fewer days than this left is reported. */
export const SSL_THRESHOLD_DAYS = 14;
/** The same site's SSL alert repeats at most this often. */
export const SSL_REPEAT_MS = DAY_MS;
/** Only vulnerabilities first seen this recently are reported. */
export const VULN_WINDOW_MS = 7 * DAY_MS;
/** Only jobs that failed this recently are reported. */
export const JOB_WINDOW_MS = DAY_MS;
/** cvss at or above this counts as critical whatever the severity text says. */
export const CRITICAL_CVSS = 9;
/** Upper bound on job error text copied into an email. */
export const ERROR_SNIPPET_MAX = 200;

const ts = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

/**
 * Decides which alerts are new, from DB state alone. Pure: no I/O, no clock
 * (state.now), so every rule is unit-testable. Dedupe is against
 * `state.history` — the `alert.sent` rows written after each successful send.
 */
export function evaluateAlerts(state: AlertState): Alert[] {
  const now = state.now.getTime();
  const sites = new Map(state.sites.filter((s) => s.status !== "disabled").map((s) => [s.id, s]));
  const link = linker(state.appUrl);
  const history = [...state.history].sort((a, b) => ts(b.at) - ts(a.at));

  const alerts: Alert[] = [
    ...uptimeAlerts(state.uptime, sites, history, now, link),
    ...vulnAlerts(state.vulns, sites, history, now, link),
    ...jobAlerts(state.failedJobs, sites, history, now, link),
  ];
  const kindOrder = (a: Alert) => ALERT_KINDS.indexOf(a.kind);
  return alerts.sort((a, b) => kindOrder(a) - kindOrder(b) || (a.site ?? "").localeCompare(b.site ?? ""));
}

type Linker = (siteId: string | null, tab?: string) => string;

function linker(appUrl: string | null): Linker {
  const base = appUrl?.trim().replace(/\/+$/, "");
  return (siteId, tab) => {
    if (!base) return "";
    const path = siteId ? `/sites/${siteId}${tab ? `/${tab}` : ""}` : "/dashboard";
    return ` ${base}${path}`;
  };
}

function uptimeAlerts(
  uptime: UptimeSample[], sites: Map<string, AlertSite>, history: AlertHistoryRow[], now: number, link: Linker,
): Alert[] {
  const bySite = new Map<string, UptimeSample[]>();
  for (const c of uptime) {
    if (!sites.has(c.site_id)) continue;
    bySite.set(c.site_id, [...(bySite.get(c.site_id) ?? []), c]);
  }
  const out: Alert[] = [];
  for (const [siteId, checks] of bySite) {
    const site = sites.get(siteId)!;
    const [latest, previous] = [...checks].sort((a, b) => ts(b.checked_at) - ts(a.checked_at));
    const lastState = history.find(
      (h) => h.site_id === siteId && (h.kind === "site_down" || h.kind === "site_recovered"),
    );
    const incidentOpen = lastState?.kind === "site_down";

    if (!latest.ok && previous && !previous.ok && !incidentOpen) {
      const status = latest.http_status === null ? "no response" : `HTTP ${latest.http_status}`;
      out.push({
        kind: "site_down", site_id: siteId, site: site.name, keys: [latest.checked_at],
        message: `${site.name} is down: the last two uptime checks failed (${status}).${link(siteId)}`,
      });
    } else if (latest.ok && incidentOpen) {
      out.push({
        kind: "site_recovered", site_id: siteId, site: site.name, keys: [latest.checked_at],
        message: `${site.name} is back up (HTTP ${latest.http_status ?? "ok"}).${link(siteId)}`,
      });
    }

    const days = latest.ssl_days_remaining;
    if (days !== null && days < SSL_THRESHOLD_DAYS) {
      const recent = history.some(
        (h) => h.site_id === siteId && h.kind === "ssl_expiring" && now - ts(h.at) < SSL_REPEAT_MS,
      );
      if (!recent) {
        const when = days < 0 ? `expired ${-days} day${-days === 1 ? "" : "s"} ago`
          : days === 0 ? "expires today"
          : `expires in ${days} day${days === 1 ? "" : "s"}`;
        out.push({
          kind: "ssl_expiring", site_id: siteId, site: site.name, keys: [String(days)],
          message: `${site.name}: SSL certificate ${when}.${link(siteId, "security")}`,
        });
      }
    }
  }
  return out;
}

function isCritical(v: VulnCandidate): boolean {
  return v.severity?.trim().toLowerCase() === "critical" || (v.cvss !== null && v.cvss >= CRITICAL_CVSS);
}

function vulnAlerts(
  vulns: VulnCandidate[], sites: Map<string, AlertSite>, history: AlertHistoryRow[], now: number, link: Linker,
): Alert[] {
  const alerted = new Set(history.filter((h) => h.kind === "critical_vulnerability").map((h) => h.key));
  return vulns
    .filter((v) => v.status === "open" && isCritical(v) && sites.has(v.site_id)
      && now - ts(v.first_seen) <= VULN_WINDOW_MS && !alerted.has(v.id))
    .map((v) => {
      const site = sites.get(v.site_id)!;
      const details = [v.cve, v.title && snippet(v.title), v.cvss !== null && `CVSS ${v.cvss}`]
        .filter(Boolean).join(", ");
      return {
        kind: "critical_vulnerability" as const, site_id: v.site_id, site: site.name, keys: [v.id],
        message: `${site.name}: critical vulnerability in ${v.component} ${v.installed_version}`
          + `${details ? ` (${details})` : ""}.${link(v.site_id, "security")}`,
      };
    });
}

function jobAlerts(
  jobs: FailedJob[], sites: Map<string, AlertSite>, history: AlertHistoryRow[], now: number, link: Linker,
): Alert[] {
  const alerted = new Set(history.filter((h) => h.kind === "jobs_failed").map((h) => h.key));
  const fresh = jobs.filter((j) => j.dismissed_at === null && j.finished_at !== null
    && now - ts(j.finished_at) <= JOB_WINDOW_MS && !alerted.has(j.id)
    && (j.site_id === null || sites.has(j.site_id)));

  const groups = new Map<string | null, FailedJob[]>();
  for (const j of fresh) groups.set(j.site_id, [...(groups.get(j.site_id) ?? []), j]);

  return [...groups].map(([siteId, group]) => {
    const name = siteId ? sites.get(siteId)!.name : null;
    const newest = [...group].sort((a, b) => ts(b.finished_at) - ts(a.finished_at))[0];
    const counts = new Map<string, number>();
    for (const j of group) counts.set(j.type, (counts.get(j.type) ?? 0) + 1);
    const types = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(", ");
    const err = newest.last_error ? ` Latest error: ${snippet(newest.last_error)}` : "";
    const n = group.length;
    return {
      kind: "jobs_failed" as const, site_id: siteId, site: name, keys: group.map((j) => j.id),
      message: `${name ?? "Fleet-wide"}: ${n} failed job${n === 1 ? "" : "s"} in the last 24h (${types}).`
        + `${err}${link(siteId)}`,
    };
  });
}

/** One line, at most ERROR_SNIPPET_MAX characters. */
export function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_SNIPPET_MAX ? `${flat.slice(0, ERROR_SNIPPET_MAX - 1)}…` : flat;
}
