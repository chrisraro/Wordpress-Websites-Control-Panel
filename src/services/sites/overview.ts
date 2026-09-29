import type { DirectoryFields } from "./directory";

/** SSL certificates this close to expiry are counted as a problem (matches the alert threshold). */
export const SSL_WARN_DAYS = 14;

/**
 * Uptime runs every 5 minutes; a newest reading older than this means the
 * checker itself has stopped, which says nothing about the site.
 */
export const UPTIME_STALE_MS = 30 * 60_000;
/** Consecutive failed checks before a site counts as down. One is a blip. */
export const DOWN_AFTER_FAILURES = 2;

export interface UptimeReading {
  latestOk: boolean | null;
  failStreak?: number;
  latestAt?: string | null;
}

/**
 * Up, down or unknown, from the latest uptime checks. Down needs two failures
 * in a row on a recent reading: the false "all sites down" incident showed
 * what a single bad reading costs when it lights up the whole dashboard.
 * `unconfirmed` = the newest check failed but the one before passed.
 */
export function liveness(
  reading: UptimeReading | null, now: number = Date.now(),
): { up: boolean | null; unconfirmed: boolean } {
  const unknown = { up: null, unconfirmed: false };
  if (!reading || reading.latestOk === null) return unknown;
  if (reading.latestAt && now - Date.parse(reading.latestAt) > UPTIME_STALE_MS) return unknown;
  if (reading.latestOk) return { up: true, unconfirmed: false };
  return (reading.failStreak ?? 1) >= DOWN_AFTER_FAILURES
    ? { up: false, unconfirmed: false }
    : { up: null, unconfirmed: true };
}

export interface FleetOverview {
  total: number;
  live: number;
  staging: number;
  disabled: number;
  critical: number;
  warn: number;
  healthy: number;
  /** Latest uptime check, per site. */
  up: number;
  down: number;
  unmeasured: number;
  /** Mean of each measured site's 24h uptime %, or null when none was measured. */
  averageUptime: number | null;
  grades: { A: number; B: number; C: number; D: number; F: number; none: number };
  updatesPending: number;
  sitesWithUpdates: number;
  averageSeo: number | null;
  sslExpiring: number;
  /** Sites with a certificate reading at all; 0 means SSL is unmeasured, not fine. */
  sslMeasured: number;
}

const mean = (xs: number[]) =>
  xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;

/**
 * The portfolio in one glance: the summary band at the top of the dashboard.
 * Derived from the same per-site fields the directory cards show, so a
 * headline number can always be reconciled with the cards below it.
 */
export function fleetOverview(sites: readonly DirectoryFields[]): FleetOverview {
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0, none: 0 };
  for (const s of sites) {
    if (s.grade && s.grade in grades) grades[s.grade as keyof typeof grades] += 1;
    else grades.none += 1;
  }
  const measuredUptime = sites.flatMap((s) => (typeof s.uptime24h === "number" ? [s.uptime24h] : []));
  const seo = sites.flatMap((s) => (typeof s.seo === "number" ? [s.seo] : []));
  const withUpdates = sites.filter((s) => (s.updates ?? 0) > 0);
  const count = (p: (s: DirectoryFields) => boolean) => sites.filter(p).length;

  return {
    total: sites.length,
    live: count((s) => s.env === "production"),
    staging: count((s) => s.env === "staging"),
    disabled: count((s) => s.status === "disabled"),
    critical: count((s) => s.severity === "critical"),
    warn: count((s) => s.severity === "warn"),
    healthy: count((s) => s.severity === "ok"),
    up: count((s) => s.up === true),
    down: count((s) => s.up === false),
    unmeasured: count((s) => s.up === null || s.up === undefined),
    averageUptime: mean(measuredUptime),
    grades,
    updatesPending: withUpdates.reduce((n, s) => n + (s.updates ?? 0), 0),
    sitesWithUpdates: withUpdates.length,
    averageSeo: mean(seo),
    sslExpiring: count((s) => typeof s.sslDays === "number" && s.sslDays < SSL_WARN_DAYS),
    sslMeasured: count((s) => typeof s.sslDays === "number"),
  };
}
