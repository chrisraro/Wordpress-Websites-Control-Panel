import { describe, it, expect } from "vitest";
import { evaluateAlerts } from "@/services/alerts/evaluate";
import type { AlertState, AlertHistoryRow, UptimeSample } from "@/services/alerts/types";

const NOW = new Date("2026-09-29T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const hoursAgo = (h: number) => minsAgo(h * 60);
const daysAgo = (d: number) => hoursAgo(d * 24);

function state(over: Partial<AlertState> = {}): AlertState {
  return {
    now: NOW,
    appUrl: null,
    sites: [
      { id: "s1", name: "Alpha", status: "connected" },
      { id: "s2", name: "Beta", status: "connected" },
    ],
    uptime: [],
    vulns: [],
    failedJobs: [],
    history: [],
    ...over,
  };
}

const check = (site_id: string, ok: boolean, m: number, ssl: number | null = 60): UptimeSample => ({
  site_id, ok, checked_at: minsAgo(m), http_status: ok ? 200 : 503, ssl_days_remaining: ssl,
});
const sent = (site_id: string | null, kind: AlertHistoryRow["kind"], key: string, at: string): AlertHistoryRow => ({
  site_id, kind, key, at,
});

describe("evaluateAlerts — site_down", () => {
  it("alerts after two consecutive failed checks", () => {
    const out = evaluateAlerts(state({ uptime: [check("s1", false, 0), check("s1", false, 5), check("s1", true, 10)] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "site_down", site_id: "s1", site: "Alpha" });
    expect(out[0].message).toContain("503");
  });

  it("does not alert on a single failed check (a blip)", () => {
    const out = evaluateAlerts(state({ uptime: [check("s1", false, 0), check("s1", true, 5)] }));
    expect(out).toEqual([]);
  });

  it("does not alert when only one check exists", () => {
    expect(evaluateAlerts(state({ uptime: [check("s1", false, 0)] }))).toEqual([]);
  });

  it("uses check order by time, not input order", () => {
    const out = evaluateAlerts(state({ uptime: [check("s1", true, 10), check("s1", false, 5), check("s1", false, 0)] }));
    expect(out.map((a) => a.kind)).toEqual(["site_down"]);
  });

  it("does not re-alert while the incident is open", () => {
    const out = evaluateAlerts(state({
      uptime: [check("s1", false, 0), check("s1", false, 5)],
      history: [sent("s1", "site_down", "k", hoursAgo(3))],
    }));
    expect(out).toEqual([]);
  });

  it("alerts again for a new incident after a recovery", () => {
    const out = evaluateAlerts(state({
      uptime: [check("s1", false, 0), check("s1", false, 5)],
      history: [sent("s1", "site_down", "a", daysAgo(2)), sent("s1", "site_recovered", "b", daysAgo(1))],
    }));
    expect(out.map((a) => a.kind)).toEqual(["site_down"]);
  });

  it("ignores disabled sites", () => {
    const out = evaluateAlerts(state({
      sites: [{ id: "s1", name: "Alpha", status: "disabled" }],
      uptime: [check("s1", false, 0), check("s1", false, 5)],
    }));
    expect(out).toEqual([]);
  });
});

describe("evaluateAlerts — site_recovered", () => {
  it("alerts when the latest check is ok and the last alert was site_down", () => {
    const out = evaluateAlerts(state({
      uptime: [check("s1", true, 0), check("s1", false, 5)],
      history: [sent("s1", "site_down", "a", hoursAgo(1))],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "site_recovered", site_id: "s1", site: "Alpha" });
  });

  it("does not alert when the last alert was already site_recovered", () => {
    const out = evaluateAlerts(state({
      uptime: [check("s1", true, 0)],
      history: [sent("s1", "site_down", "a", hoursAgo(2)), sent("s1", "site_recovered", "b", hoursAgo(1))],
    }));
    expect(out).toEqual([]);
  });

  it("does not alert for a site that was never reported down", () => {
    expect(evaluateAlerts(state({ uptime: [check("s1", true, 0), check("s1", false, 5)] }))).toEqual([]);
  });

  it("uses the newest history row regardless of input order", () => {
    const out = evaluateAlerts(state({
      uptime: [check("s1", true, 0)],
      history: [sent("s1", "site_recovered", "b", daysAgo(3)), sent("s1", "site_down", "a", hoursAgo(1))],
    }));
    expect(out.map((a) => a.kind)).toEqual(["site_recovered"]);
  });
});

describe("evaluateAlerts — ssl_expiring", () => {
  it("alerts when fewer than 14 days remain", () => {
    const out = evaluateAlerts(state({ uptime: [check("s1", true, 0, 13)] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "ssl_expiring", site_id: "s1" });
    expect(out[0].message).toContain("13 days");
  });

  it("does not alert at exactly 14 days", () => {
    expect(evaluateAlerts(state({ uptime: [check("s1", true, 0, 14)] }))).toEqual([]);
  });

  it("alerts for an expired certificate (negative days)", () => {
    const out = evaluateAlerts(state({ uptime: [check("s1", true, 0, -2)] }));
    expect(out[0].kind).toBe("ssl_expiring");
    expect(out[0].message.toLowerCase()).toContain("expired");
  });

  it("ignores an unknown SSL value", () => {
    expect(evaluateAlerts(state({ uptime: [check("s1", true, 0, null)] }))).toEqual([]);
  });

  it("alerts at most once per 24 hours per site", () => {
    const recent = evaluateAlerts(state({
      uptime: [check("s1", true, 0, 5)],
      history: [sent("s1", "ssl_expiring", "6", hoursAgo(23))],
    }));
    expect(recent).toEqual([]);
    const stale = evaluateAlerts(state({
      uptime: [check("s1", true, 0, 5)],
      history: [sent("s1", "ssl_expiring", "6", hoursAgo(25))],
    }));
    expect(stale.map((a) => a.kind)).toEqual(["ssl_expiring"]);
  });

  it("an SSL alert on one site does not suppress another", () => {
    const out = evaluateAlerts(state({
      uptime: [check("s1", true, 0, 5), check("s2", true, 0, 5)],
      history: [sent("s1", "ssl_expiring", "5", hoursAgo(1))],
    }));
    expect(out.map((a) => a.site_id)).toEqual(["s2"]);
  });
});

describe("evaluateAlerts — critical_vulnerability", () => {
  const vuln = (over: Partial<AlertState["vulns"][number]> = {}): AlertState["vulns"][number] => ({
    id: "v1", site_id: "s1", component: "contact-form-7", installed_version: "5.0",
    severity: "critical", cvss: 9.8, title: "RCE in CF7", cve: "CVE-2026-0001",
    first_seen: daysAgo(1), status: "open", ...over,
  });

  it("alerts for an open critical vulnerability first seen within 7 days", () => {
    const out = evaluateAlerts(state({ vulns: [vuln()] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "critical_vulnerability", site_id: "s1", keys: ["v1"] });
    expect(out[0].message).toContain("contact-form-7");
    expect(out[0].message).toContain("CVE-2026-0001");
  });

  it("treats cvss >= 9 as critical even when severity text differs", () => {
    const out = evaluateAlerts(state({ vulns: [vuln({ severity: null, cvss: 9 })] }));
    expect(out.map((a) => a.kind)).toEqual(["critical_vulnerability"]);
  });

  it("matches severity text case-insensitively", () => {
    expect(evaluateAlerts(state({ vulns: [vuln({ severity: "Critical", cvss: null })] }))).toHaveLength(1);
  });

  it("ignores non-critical, non-open and old vulnerabilities", () => {
    const out = evaluateAlerts(state({
      vulns: [
        vuln({ id: "a", severity: "high", cvss: 8.9 }),
        vuln({ id: "b", status: "fixed" }),
        vuln({ id: "c", status: "ignored" }),
        vuln({ id: "d", first_seen: daysAgo(8) }),
      ],
    }));
    expect(out).toEqual([]);
  });

  it("does not re-alert a vulnerability already alerted", () => {
    const out = evaluateAlerts(state({
      vulns: [vuln({ id: "v1" }), vuln({ id: "v2", component: "akismet" })],
      history: [sent("s1", "critical_vulnerability", "v1", daysAgo(1))],
    }));
    expect(out.map((a) => a.keys)).toEqual([["v2"]]);
  });
});

describe("evaluateAlerts — jobs_failed", () => {
  const job = (over: Partial<AlertState["failedJobs"][number]> = {}): AlertState["failedJobs"][number] => ({
    id: "j1", site_id: "s1", type: "security_scan", finished_at: hoursAgo(1),
    last_error: "boom", dismissed_at: null, ...over,
  });

  it("bundles every new failed job for a site into one alert", () => {
    const out = evaluateAlerts(state({
      failedJobs: [job({ id: "j1" }), job({ id: "j2", type: "snapshot_refresh" }), job({ id: "j3", site_id: "s2" })],
    }));
    expect(out).toHaveLength(2);
    const s1 = out.find((a) => a.site_id === "s1")!;
    expect(s1.kind).toBe("jobs_failed");
    expect([...s1.keys].sort()).toEqual(["j1", "j2"]);
    expect(s1.message).toContain("2 failed jobs");
    expect(s1.message).toContain("security_scan");
    expect(s1.message).toContain("snapshot_refresh");
  });

  it("handles fleet-wide jobs with no site", () => {
    const out = evaluateAlerts(state({ failedJobs: [job({ site_id: null, type: "vuln_feed_refresh" })] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "jobs_failed", site_id: null, site: null });
  });

  it("skips jobs already alerted, dismissed, or older than 24h", () => {
    const out = evaluateAlerts(state({
      failedJobs: [
        job({ id: "j1" }),
        job({ id: "j2", dismissed_at: hoursAgo(0.5) }),
        job({ id: "j3", finished_at: hoursAgo(25) }),
        job({ id: "j4", finished_at: null }),
      ],
      history: [sent("s1", "jobs_failed", "j1", hoursAgo(0.5))],
    }));
    expect(out).toEqual([]);
  });

  it("truncates the last error to about 200 characters", () => {
    const out = evaluateAlerts(state({ failedJobs: [job({ last_error: "x".repeat(5000) })] }));
    expect(out[0].message.length).toBeLessThan(400);
    expect(out[0].message).not.toContain("x".repeat(250));
  });
});

describe("evaluateAlerts — links", () => {
  it("adds the panel link for the site when APP_URL is set", () => {
    const out = evaluateAlerts(state({
      appUrl: "https://panel.test/",
      uptime: [check("s1", false, 0), check("s1", false, 5)],
    }));
    expect(out[0].message).toContain("https://panel.test/sites/s1");
    expect(out[0].message).not.toContain("panel.test//");
  });

  it("links vulnerabilities and SSL alerts to the security tab", () => {
    const out = evaluateAlerts(state({ appUrl: "https://panel.test", uptime: [check("s1", true, 0, 3)] }));
    expect(out[0].message).toContain("https://panel.test/sites/s1/security");
  });

  it("adds no link without APP_URL", () => {
    const out = evaluateAlerts(state({ uptime: [check("s1", false, 0), check("s1", false, 5)] }));
    expect(out[0].message).not.toContain("http");
  });
});

describe("evaluateAlerts — ordering", () => {
  it("returns alerts grouped by kind in a stable order", () => {
    const out = evaluateAlerts(state({
      uptime: [check("s1", false, 0, 3), check("s1", false, 5), check("s2", true, 0)],
      history: [sent("s2", "site_down", "x", hoursAgo(1))],
      failedJobs: [{ id: "j", site_id: "s2", type: "seo_scan", finished_at: hoursAgo(1), last_error: null, dismissed_at: null }],
    }));
    expect(out.map((a) => a.kind)).toEqual(["site_down", "site_recovered", "ssl_expiring", "jobs_failed"]);
  });
});
