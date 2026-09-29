import { describe, expect, it } from "vitest";
import {
  backupItem, careItem, reportLink, sslItem, uptimeItem, type EvidenceItem,
} from "@/services/client/format";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-29T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Every line on this screen is read by a paying customer. None of them may
// carry the agency's internal words, plugin names or mechanism.
const STAFF_WORDS = [
  "updraft", "plugin", "snapshot", "inventory", "mcp", "activity", "log", "job",
  "queue", "token", "uptime_checks", "null", "undefined", "nan",
];
function expectClientSafe(item: EvidenceItem | null) {
  if (!item) return;
  const text = `${item.label} ${item.value} ${item.detail ?? ""}`.toLowerCase();
  // Word boundaries: "maintenance" contains "nan" and is fine.
  for (const w of STAFF_WORDS) expect(text).not.toMatch(new RegExp(`\\b${w}\\b`));
}

describe("uptimeItem", () => {
  it("says 'Not measured yet' when there are no checks -- never 100% by default", () => {
    const item = uptimeItem({ total: 0, ok: 0, firstIso: null }, NOW);
    expect(item?.value).toBe("Not measured yet");
    expect(item?.value).not.toMatch(/100/);
    expect(item?.tone).toBe("idle");
  });

  it("omits the line entirely when the tally could not be read", () => {
    // Unknown is not unmeasured: saying "Not measured yet" after a failed
    // read would be a claim nobody checked.
    expect(uptimeItem(null, NOW)).toBeNull();
  });

  it("shows 100% only when every check passed", () => {
    expect(uptimeItem({ total: 8640, ok: 8640, firstIso: ago(30) }, NOW)?.value).toBe("100%");
  });

  it("never rounds a single failure up to 100%", () => {
    const item = uptimeItem({ total: 8640, ok: 8639, firstIso: ago(30) }, NOW);
    expect(item?.value).not.toBe("100%");
    expect(item?.value).toBe("99.98%");
  });

  it("covers the last 30 days when checks span the window", () => {
    expect(uptimeItem({ total: 10, ok: 10, firstIso: ago(29.9) }, NOW)?.detail).toBe("Last 30 days");
  });

  it("says how long monitoring has run when it is younger than the window", () => {
    const item = uptimeItem({ total: 800, ok: 800, firstIso: ago(3) }, NOW);
    expect(item?.detail).toBe("Since checks began 3 days ago");
  });

  it("flags a poor month as a warning, not a success", () => {
    const item = uptimeItem({ total: 100, ok: 90, firstIso: ago(30) }, NOW);
    expect(item?.value).toBe("90%");
    expect(item?.tone).toBe("warn");
  });

  it("stays client-safe", () => {
    expectClientSafe(uptimeItem({ total: 0, ok: 0, firstIso: null }, NOW));
    expectClientSafe(uptimeItem({ total: 5, ok: 4, firstIso: ago(1) }, NOW));
  });
});

describe("sslItem", () => {
  it("omits the line when SSL was never measured", () => {
    expect(sslItem(null, NOW)).toBeNull();
  });

  it("states how long the certificate is valid for", () => {
    const item = sslItem({ days: 42, checkedAtIso: ago(0) }, NOW);
    expect(item?.value).toBe("Valid for 42 more days");
    expect(item?.tone).toBe("good");
  });

  it("counts down from when the check ran, not from now", () => {
    expect(sslItem({ days: 42, checkedAtIso: ago(2) }, NOW)?.value).toBe("Valid for 40 more days");
  });

  it("says 'Renews soon' under 14 days", () => {
    expect(sslItem({ days: 13, checkedAtIso: ago(0) }, NOW)?.value).toBe("Renews soon");
    expect(sslItem({ days: 0, checkedAtIso: ago(0) }, NOW)?.value).toBe("Renews soon");
    expect(sslItem({ days: 14, checkedAtIso: ago(0) }, NOW)?.value).toBe("Valid for 14 more days");
  });

  it("says 'Expired' once the certificate has lapsed", () => {
    const item = sslItem({ days: -1, checkedAtIso: ago(0) }, NOW);
    expect(item?.value).toBe("Expired");
    expect(item?.tone).toBe("bad");
    // A measurement that has since run out is expired too.
    expect(sslItem({ days: 3, checkedAtIso: ago(5) }, NOW)?.value).toBe("Expired");
  });

  it("omits a measurement too old to stand behind", () => {
    expect(sslItem({ days: 300, checkedAtIso: ago(31) }, NOW)).toBeNull();
  });
});

describe("backupItem", () => {
  const status = (over: Partial<{ last_backup_time: number | null; success: boolean | null }> = {}) => ({
    plugin: "updraftplus" as const, last_backup_time: unix(ago(2)), success: true, ...over,
  });

  it("omits the line for a snapshot taken before backups were measured", () => {
    expect(backupItem(undefined, NOW)).toBeNull();
  });

  it("omits the line when no supported backup tool is present (unknown, not 'none')", () => {
    expect(backupItem(null, NOW)).toBeNull();
  });

  it("says when the site was last backed up", () => {
    const item = backupItem(status(), NOW);
    expect(item?.value).toBe("Backed up 2 days ago");
    expect(item?.tone).toBe("good");
    expect(backupItem(status({ last_backup_time: unix(ago(0.1)) }), NOW)?.value).toBe("Backed up today");
  });

  it("says 'No recent backup' after 7 days", () => {
    const item = backupItem(status({ last_backup_time: unix(ago(8)) }), NOW);
    expect(item?.value).toBe("No recent backup");
    expect(item?.tone).toBe("warn");
    expect(backupItem(status({ last_backup_time: unix(ago(7)) }), NOW)?.value).toBe("Backed up 7 days ago");
  });

  it("does not count a failed run as a backup", () => {
    expect(backupItem(status({ success: false }), NOW)?.value).toBe("No recent backup");
  });

  it("says 'No recent backup' when the tool has never recorded one", () => {
    expect(backupItem(status({ last_backup_time: null, success: null }), NOW)?.value).toBe("No recent backup");
  });

  it("omits the line when the outcome of the last run is unknown", () => {
    expect(backupItem(status({ success: null }), NOW)).toBeNull();
  });

  it("never names the backup plugin", () => {
    expectClientSafe(backupItem(status(), NOW));
    expectClientSafe(backupItem(status({ success: false }), NOW));
  });
});

describe("careItem", () => {
  const thisMonth = "2026-09-10T00:00:00Z";
  const lastMonth = "2026-08-30T00:00:00Z";

  it("counts completed maintenance this month", () => {
    expect(careItem(3, thisMonth, NOW)?.value).toBe("3 maintenance updates this month");
    expect(careItem(1, thisMonth, NOW)?.value).toBe("1 maintenance update this month");
    expect(careItem(3, thisMonth, NOW)?.tone).toBe("good");
  });

  it("says nothing was needed only when a check actually ran this month", () => {
    expect(careItem(0, thisMonth, NOW)?.value).toBe("No changes needed this month");
    expect(careItem(0, lastMonth, NOW)).toBeNull();
    expect(careItem(0, null, NOW)).toBeNull();
  });

  it("omits the line when the count could not be read", () => {
    expect(careItem(null, thisMonth, NOW)).toBeNull();
  });

  it("stays client-safe", () => {
    expectClientSafe(careItem(2, thisMonth, NOW));
    expectClientSafe(careItem(0, thisMonth, NOW));
  });
});

describe("reportLink", () => {
  const report = (over: Partial<{
    share_token: string | null; share_expires_at: string | null; period_end: string | null; generated_at: string;
  }> = {}) => ({
    share_token: "abc123", share_expires_at: new Date(NOW + 10 * DAY).toISOString(),
    period_end: "2026-08-31", generated_at: "2026-09-01T00:00:00Z", ...over,
  });

  it("links the newest report's share page when its link is active", () => {
    const link = reportLink("s1", report(), NOW);
    expect(link.href).toBe("/r/abc123");
    expect(link.label).toBe("Latest report · August 2026");
  });

  it("falls back to the site's reports when the newest link has expired", () => {
    const link = reportLink("s1", report({ share_expires_at: new Date(NOW - DAY).toISOString() }), NOW);
    expect(link).toEqual({ href: "/sites/s1/reports", label: "Reports for this site" });
  });

  it("falls back when the newest report was never shared or was revoked", () => {
    expect(reportLink("s1", report({ share_token: null }), NOW).href).toBe("/sites/s1/reports");
  });

  it("falls back when there is no report or it could not be read", () => {
    expect(reportLink("s1", null, NOW).href).toBe("/sites/s1/reports");
  });

  it("names the month from generation time when the report has no period", () => {
    expect(reportLink("s1", report({ period_end: null }), NOW).label).toBe("Latest report · September 2026");
  });
});
