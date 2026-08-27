import { decryptSecret } from "@/lib/crypto/secrets";
import { getOptionalEnv } from "@/lib/env";
import { fetchWordfenceFeed } from "@/lib/adapters/vulnfeed/wordfence";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";
import { refreshSnapshot } from "@/services/inventory/service";
import { matchInventory } from "./vulns";
import { runPhpHardening, runHttpHardening } from "./hardening";
import { runChecksums } from "./checksums";
import { computeGrade, type Grade, type SecurityCheck, type Severity } from "./types";
import type { SecurityRepo } from "./repo";

export interface ScanDeps {
  sites: SitesRepo;
  snapshots: SnapshotsRepo;
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
    } else {
      checks.push({
        check_id: "wordfence_feed", result: "warn",
        details: { message: "Vulnerability feed not cached — set WORDFENCE_API_KEY and wait for the nightly refresh." },
      });
    }

    const creds = await deps.sites.getSiteCredentials(siteId);
    if (!creds) throw new Error(`Credentials missing for site: ${siteId}`);
    const client = await deps.mcp({
      endpoint: creds.mcp_endpoint,
      username: creds.wp_username,
      appPassword: await decryptSecret(creds.app_password_encrypted),
    });
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

export async function refreshVulnFeed(
  security: SecurityRepo, fetchImpl?: typeof fetch,
): Promise<{ updated: number; skipped: boolean }> {
  const key = getOptionalEnv("WORDFENCE_API_KEY");
  if (!key) return { updated: 0, skipped: true };
  const entries = await fetchWordfenceFeed(key, fetchImpl ?? fetch);
  const updated = await security.replaceFeed(entries);
  return { updated, skipped: false };
}
