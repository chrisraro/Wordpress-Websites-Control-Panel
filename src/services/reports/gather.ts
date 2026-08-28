import type { SitesRepo } from "@/services/sites/repo";
import type { SecurityRepo } from "@/services/security/repo";
import type { SeoRepo } from "@/services/seo/repo";
import type { GeoGridRepo } from "@/services/geogrid/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";
import { pendingUpdates, type InventoryPayload } from "@/services/inventory/types";
import { averageRank, coverage } from "@/services/geogrid/types";
import type {
  GeoGridSection, InventorySection, ReportData, ReportSection,
  SecuritySection, SeoSection,
} from "./types";

export interface GatherDeps {
  sites: SitesRepo;
  security: SecurityRepo;
  seo: SeoRepo;
  geogrid: GeoGridRepo;
  snapshots: SnapshotsRepo;
}

/** Pull the `data` out of a stored SEO snapshot row, or null when it errored. */
function seoData<T>(row: { payload: unknown } | undefined): T | null {
  const p = row?.payload as { status?: string; data?: T } | undefined;
  return p?.status === "ok" && p.data !== undefined ? p.data : null;
}

async function buildSecurity(deps: GatherDeps, siteId: string): Promise<SecuritySection> {
  const [grade, vulns, checks, uptime] = await Promise.all([
    deps.security.latestGrade(siteId),
    deps.security.openVulns(siteId),
    deps.security.latestChecks(siteId),
    deps.security.uptimeSummary(siteId),
  ]);
  return {
    grade: grade?.grade ?? null,
    score: grade?.score ?? null,
    openVulns: vulns.length,
    criticalVulns: vulns.filter((v) => v.severity === "critical").length,
    failedChecks: (checks?.checks ?? [])
      .filter((c) => c.result !== "pass" && c.check_id !== "grade")
      .map((c) => ({ id: c.check_id, result: c.result })),
    uptime24h: uptime.uptime24h,
    sslDays: uptime.sslDays,
    scannedAt: checks?.runAt ?? null,
  };
}

async function buildSeo(deps: GatherDeps, siteId: string): Promise<SeoSection> {
  const latest = await deps.seo.latestBySource(siteId);
  const audit = seoData<{ score: number | null; grade?: string; findings?: Array<{ title: string; status: string }> }>(latest.rankmath_audit);
  const scores = seoData<{ pages: Array<{ title: string; score: number | null }> }>(latest.rankmath_scores);
  const keywords = seoData<{ connected: boolean; keywords: Array<{ keyword: string; clicks: number; position: number }> }>(latest.keywords);
  const psi = seoData<{ mobile: { performance: number | null } | null; desktop: { performance: number | null } | null }>(latest.psi);
  const aeo = seoData<{ brands: Array<{ name: string; score: number | null }> }>(latest.ai_visibility);

  return {
    auditScore: audit?.score ?? null,
    grade: audit?.grade ?? null,
    failingFindings: (audit?.findings ?? [])
      .filter((f) => f.status === "fail" || f.status === "warning")
      .slice(0, 10)
      .map((f) => ({ title: f.title, status: f.status })),
    worstPages: [...(scores?.pages ?? [])]
      .sort((a, b) => (a.score ?? 101) - (b.score ?? 101))
      .slice(0, 5)
      .map((p) => ({ title: p.title, score: p.score })),
    keywordsConnected: keywords?.connected === true,
    topKeywords: (keywords?.keywords ?? []).slice(0, 10)
      .map((k) => ({ keyword: k.keyword, clicks: k.clicks, position: k.position })),
    psiMobile: psi?.mobile?.performance ?? null,
    psiDesktop: psi?.desktop?.performance ?? null,
    brands: (aeo?.brands ?? []).map((b) => ({ name: b.name, score: b.score })),
    scannedAt: latest.rankmath_audit?.taken_at ?? null,
  };
}

async function buildGeoGrid(deps: GatherDeps, siteId: string): Promise<GeoGridSection> {
  const config = await deps.geogrid.getConfigBySite(siteId);
  if (!config) return { businessName: null, keywords: [] };
  const latest = await deps.geogrid.latestPerKeyword(config.id);
  return {
    businessName: config.business_name,
    keywords: Object.values(latest).map((snap) => ({
      keyword: snap.keyword,
      averageRank: averageRank(snap.points),
      coverage: coverage(snap.points),
      runAt: snap.run_at,
    })),
  };
}

async function buildInventory(deps: GatherDeps, siteId: string): Promise<InventorySection> {
  const snap = await deps.snapshots.latestSnapshot(siteId);
  if (!snap) {
    return { wpVersion: null, phpVersion: null, pluginCount: 0, pendingUpdates: 0, coreUpdate: null, collectedAt: null };
  }
  const payload = snap.payload as InventoryPayload;
  return {
    wpVersion: payload.wp_version ?? null,
    phpVersion: payload.php_version ?? null,
    pluginCount: payload.plugins?.length ?? 0,
    pendingUpdates: pendingUpdates(payload),
    coreUpdate: payload.core_update ?? null,
    collectedAt: snap.taken_at,
  };
}

export async function gatherReportData(
  deps: GatherDeps, siteId: string, sections: ReportSection[], periodDays: number,
): Promise<ReportData> {
  const site = await deps.sites.getSite(siteId);
  if (!site) throw new Error(`Site not found: ${siteId}`);

  const now = new Date();
  const start = new Date(now.getTime() - periodDays * 24 * 3600 * 1000);
  const want = new Set(sections);

  const [security, seo, geogrid, inventory] = await Promise.all([
    want.has("security") ? buildSecurity(deps, siteId) : Promise.resolve(null),
    want.has("seo") ? buildSeo(deps, siteId) : Promise.resolve(null),
    want.has("geogrid") ? buildGeoGrid(deps, siteId) : Promise.resolve(null),
    want.has("inventory") ? buildInventory(deps, siteId) : Promise.resolve(null),
  ]);

  return {
    meta: {
      siteName: site.name,
      siteUrl: site.url,
      generatedAt: now.toISOString(),
      periodStart: start.toISOString(),
      periodEnd: now.toISOString(),
      sections,
    },
    security, seo, geogrid, inventory,
  };
}
