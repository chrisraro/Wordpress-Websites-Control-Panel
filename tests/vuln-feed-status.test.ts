import { describe, it, expect } from "vitest";
import { vulnFeedStatus } from "@/services/security/scan";

// vulnFeedStatus (src/services/security/scan.ts) is the dashboard's
// system-health source of truth for the vuln_feed table's own condition --
// deliberately independent of any job's outcome, because refreshVulnFeed
// returns {skipped: true} (and the handler marks the job "done") whenever
// the cached feed is already fresh, so a job history full of "done" rows
// says nothing about whether the feed has ever actually been populated.
//
// "Never populated" and "stale" must read as different problems: an empty
// feed means every security grade to date excluded vulnerability matching
// entirely, a stale one means grades are matched against an out-of-date
// list. Conflating them points an operator at the wrong remedy.

const NOW = new Date("2026-08-29T12:00:00Z").getTime();

describe("vulnFeedStatus", () => {
  it("reports 'never' when the feed has no rows at all (newestUpdatedAt is null)", () => {
    const status = vulnFeedStatus(null, NOW);
    expect(status.state).toBe("never");
    expect(status.message).toMatch(/never been populated/i);
  });

  it("reports 'stale' once the newest row is older than the staleness threshold", () => {
    const oldTs = new Date(NOW - 40 * 60 * 60 * 1000).toISOString(); // 40h ago
    const status = vulnFeedStatus(oldTs, NOW);
    expect(status.state).toBe("stale");
    expect(status.message).toMatch(/stale/i);
    expect(status.message).toMatch(/40h ago/); // formatAge prints hours below 48h
  });

  it("reports 'fresh' and says nothing when the newest row is within the threshold", () => {
    const freshTs = new Date(NOW - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const status = vulnFeedStatus(freshTs, NOW);
    expect(status.state).toBe("fresh");
    expect(status.message).toBeNull();
  });

  it("does not treat a fresh feed just under the threshold as stale", () => {
    const justUnder = new Date(NOW - 35 * 60 * 60 * 1000).toISOString(); // 35h ago
    expect(vulnFeedStatus(justUnder, NOW).state).toBe("fresh");
  });

  it("produces three distinct messages across the three states", () => {
    const oldTs = new Date(NOW - 40 * 60 * 60 * 1000).toISOString();
    const freshTs = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const messages = [
      vulnFeedStatus(null, NOW).message,
      vulnFeedStatus(oldTs, NOW).message,
      vulnFeedStatus(freshTs, NOW).message,
    ];
    expect(new Set(messages).size).toBe(3);
  });
});
