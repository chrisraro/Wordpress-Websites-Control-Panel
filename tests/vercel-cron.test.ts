import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Guards the root-cause fix behind the fix/duplicate-cron-and-vuln-feed
// branch: a Vercel Cron entry for /api/cron/enqueue (or any of the other two
// pg_cron-owned routes) is a second scheduler. enqueueJob's dedupe guard
// only suppresses a duplicate while an identical job is still pending, so it
// does nothing once the first scheduler's batch has already run — a second
// trigger just re-enqueues the whole nightly fan-out, silently doubling
// every client site's snapshot, security scan, and Wordfence-backed vuln
// feed refresh in one night. See docs/ops/scheduling.md ("Why pg_cron
// only") for the full incident this reproduces if reintroduced.
const VERCEL_JSON = readFileSync(path.join(__dirname, "../vercel.json"), "utf8");

describe("vercel.json", () => {
  it("declares no crons — pg_cron is the only scheduler (see docs/ops/scheduling.md)", () => {
    const config: Record<string, unknown> = JSON.parse(VERCEL_JSON);
    expect(
      config.crons,
      "vercel.json declares a `crons` entry. A second scheduler alongside " +
        "pg_cron silently doubles every client site's nightly load (double " +
        "snapshot/security-scan runs, a doubled Wordfence feed fetch) " +
        "because enqueueJob's dedupe guard cannot detect a job that already " +
        "ran to completion, only one still pending. Remove it — see " +
        "docs/ops/scheduling.md.",
    ).toBeUndefined();
  });
});
