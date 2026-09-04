import { connectToSite } from "@/lib/mcp/connect";
import { getOptionalEnv } from "@/lib/env";
import { fetchWordfenceFeed } from "@/lib/adapters/vulnfeed/wordfence";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { AdminUsersRepo, SnapshotsRepo } from "@/services/inventory/repo";
import { refreshSnapshot } from "@/services/inventory/service";
import { matchInventory } from "./vulns";
import { runPhpHardening, runHttpHardening } from "./hardening";
import { runChecksums } from "./checksums";
import { computeGrade, type Grade, type SecurityCheck, type Severity } from "./types";
import type { SecurityRepo } from "./repo";

// A scan grading against a feed this old is grading against data that is
// meaningfully out of date: the nightly job should touch the feed at least
// once a day, so one full day plus enough slack to not fire on an
// occasionally-late run (e.g. a Vercel cold start or a transient Wordfence
// error that still recovers on the next attempt) means at least one full
// nightly refresh was missed outright.
const VULN_FEED_STALE_WARN_MS = 36 * 60 * 60 * 1000; // 36 hours

function formatAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type VulnFeedState = "never" | "stale" | "fresh";

export interface VulnFeedStatus {
  state: VulnFeedState;
  /** Copy for the dashboard's system-health panel. Null when fresh — a
   *  healthy feed has nothing to say (see dashboard/page.tsx). */
  message: string | null;
}

/**
 * The vulnerability feed's condition, independent of any job's outcome.
 *
 * This is deliberately not derived from whether `vuln_feed_refresh` last
 * succeeded: `refreshVulnFeed` returns `{skipped: true}` when the cached feed
 * is already fresh, and the job handler marks that outcome `done` — so a job
 * history full of "done" rows tells you nothing about whether the feed itself
 * has ever been populated. `newestFeedUpdatedAt()` (SecurityRepo) is the one
 * source of truth for that, because it reads the table the feed actually
 * lives in.
 *
 * "Never populated" and "stale" get different sentences on purpose (see the
 * dashboard spec this implements): an empty feed means every security grade
 * to date has excluded vulnerability matching entirely, while a stale one
 * means grades are being matched against an out-of-date list. Conflating them
 * points an operator at the wrong remedy.
 */
export function vulnFeedStatus(newestUpdatedAt: string | null, now: number = Date.now()): VulnFeedStatus {
  if (!newestUpdatedAt) {
    return {
      state: "never",
      message:
        "The vulnerability feed has never been populated. No security grade has ever included " +
        "vulnerability matching — set WORDFENCE_API_KEY and run the feed refresh.",
    };
  }
  const ageMs = now - new Date(newestUpdatedAt).getTime();
  if (ageMs > VULN_FEED_STALE_WARN_MS) {
    return {
      state: "stale",
      message:
        `The vulnerability feed is stale — last refreshed ${formatAge(ageMs)} ago. Security grades ` +
        "are being matched against an out-of-date vulnerability list.",
    };
  }
  return { state: "fresh", message: null };
}

export interface ScanDeps {
  sites: SitesRepo;
  snapshots: SnapshotsRepo;
  adminUsers: AdminUsersRepo;
  security: SecurityRepo;
  mcp: McpFactory;
  fetchImpl?: typeof fetch;
}

export async function securityScan(
  deps: ScanDeps, siteId: string,
): Promise<{ grade: Grade; vulnCount: number }> {
  try {
    const site = await deps.sites.getSite(siteId);
    if (!site) throw new Error(`Site not found: ${siteId}`);

    let snapshot = (await deps.snapshots.latestSnapshot(siteId))?.payload ?? null;
    if (!snapshot) snapshot = await refreshSnapshot(deps, siteId);

    const checks: SecurityCheck[] = [];
    let vulnSeverities: (Severity | null)[] = [];
    let vulnCount = 0;

    if (await deps.security.hasFeedEntries()) {
      const keys = [
        { type: "core", slug: "wordpress" },
        ...snapshot.plugins.map((p) => ({ type: "plugin", slug: p.name })),
        ...snapshot.themes.map((t) => ({ type: "theme", slug: t.name })),
      ];
      const entries = await deps.security.feedEntriesForSlugs(keys);
      const matches = matchInventory(entries, snapshot);
      await deps.security.syncSiteVulns(siteId, matches);
      const open = await deps.security.openVulns(siteId);
      vulnSeverities = open.map((v) => v.severity);
      vulnCount = open.length;

      // The feed existing isn't enough: a scan against a feed that stopped
      // refreshing days ago produces a confidently-wrong grade, checked
      // against vulnerabilities the feed doesn't know about yet.
      const newest = await deps.security.newestFeedUpdatedAt();
      const ageMs = newest ? Date.now() - new Date(newest).getTime() : null;
      if (ageMs !== null && ageMs > VULN_FEED_STALE_WARN_MS) {
        // A distinct check_id from the absent-feed case below: "never set up"
        // and "was working, now four days dead" need different remediation,
        // and the security page renders check_id -> label with no access to
        // `details`, so collapsing them into one id makes them indistinguishable
        // on screen and unqueryable apart in security_checks.
        checks.push({
          check_id: "wordfence_feed_stale", result: "warn",
          details: { message: `Vulnerability feed is stale — last refreshed ${formatAge(ageMs)} ago.` },
        });
      }
    } else {
      checks.push({
        check_id: "wordfence_feed", result: "warn",
        details: { message: "Vulnerability feed not cached — set WORDFENCE_API_KEY and wait for the nightly refresh." },
      });
    }

    const creds = await deps.sites.getSiteCredentials(siteId);
    if (!creds) throw new Error(`Credentials missing for site: ${siteId}`);
    const client = await connectToSite(deps.mcp, creds);
    try {
      checks.push(...(await runPhpHardening(client)));
      checks.push(await runChecksums(client));
    } finally {
      await client.close();
    }
    checks.push(...(await runHttpHardening(site.url, deps.fetchImpl)));

    const { uptime24h } = await deps.security.uptimeSummary(siteId);
    const grade = computeGrade({ vulnSeverities, checks, uptime24h });
    const runAt = new Date().toISOString();
    await deps.security.insertChecks(siteId, runAt, [
      ...checks,
      { check_id: "grade", result: "pass", details: { grade: grade.grade, score: grade.score, vulns: vulnCount } },
    ]);
    await deps.sites.recordScanResult(siteId, true);
    return { grade, vulnCount };
  } catch (e) {
    await deps.sites.recordScanResult(siteId, false).catch(() => {});
    throw e;
  }
}

/**
 * Fetches the whole vulnerability feed and replaces the cached copy.
 *
 * There is deliberately no "the feed is recent, skip it" guard here, and the
 * one that used to live here was removed after it silently broke the feed in
 * production. It skipped when `newestFeedUpdatedAt()` was under 12h old, which
 * is a test of whether some rows are RECENT, not of whether the feed is
 * COMPLETE — and those come apart exactly when it matters. `replaceFeed`
 * upserts in chunks and stamps `updated_at = now()` on each chunk as it
 * commits, so a run that dies partway leaves a fresh timestamp on a partial
 * feed.
 *
 * That is not hypothetical. A run died on chunk 8 of 87 with 4,000 of 43,060
 * rows written; the next job saw a 34-minute-old timestamp, skipped the fetch,
 * and reported success in 0.4s. The feed sat 9% populated while every security
 * scan graded against it and reported sites clean that were not — a security
 * product confidently wrong, which is worse than one visibly broken. The old
 * guard's own comment anticipated this for a RETRY of the same job and passed
 * `allowSkip: false` there, but a brand-new job after a previous job's partial
 * write walked straight into it.
 *
 * What is given up is suppression of a same-night double-trigger. That costs
 * one redundant 155MB fetch, and it is already prevented upstream anyway:
 * the nightly enqueue passes `dedupe: true` (api/cron/enqueue), and
 * docs/ops/scheduling.md mandates pg_cron as the only scheduler. Trading a
 * duplicate download for the chance of a silently incomplete vulnerability
 * database was never a good trade.
 */
export async function refreshVulnFeed(
  security: SecurityRepo, fetchImpl?: typeof fetch,
): Promise<{ updated: number; skipped: boolean }> {
  const key = getOptionalEnv("WORDFENCE_API_KEY");
  // The one legitimate skip: no key configured. Distinct from "already fresh"
  // in that it does no work because it CANNOT, and says so honestly.
  if (!key) return { updated: 0, skipped: true };

  const entries = await fetchWordfenceFeed(key, fetchImpl ?? fetch);
  const updated = await security.replaceFeed(entries);
  return { updated, skipped: false };
}
