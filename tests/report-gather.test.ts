import { describe, it, expect } from "vitest";
import { REPORT_SECTIONS, parseSections } from "@/services/reports/types";
import { gatherReportData, type GatherDeps } from "@/services/reports/gather";
import type { SitesRepo } from "@/services/sites/repo";
import type { SecurityRepo } from "@/services/security/repo";
import type { SeoRepo } from "@/services/seo/repo";
import type { GeoGridRepo } from "@/services/geogrid/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";

describe("parseSections", () => {
  it("lists the four sections", () => {
    expect(REPORT_SECTIONS).toEqual(["security", "seo", "geogrid", "inventory"]);
  });
  it("keeps valid sections in canonical order and dedupes", () => {
    expect(parseSections(["seo", "security", "seo"])).toEqual(["security", "seo"]);
  });
  it("drops unknown values and tolerates garbage input", () => {
    expect(parseSections(["seo", "nonsense", 42, null])).toEqual(["seo"]);
    expect(parseSections("seo")).toEqual([]);
    expect(parseSections(null)).toEqual([]);
    expect(parseSections([])).toEqual([]);
  });
});

function deps(over: Partial<GatherDeps> = {}): GatherDeps {
  const sites = {
    async getSite(id: string) {
      return id === "site-1"
        ? { id, name: "El Nido Guide", url: "https://elnido.test", mcp_endpoint: "x",
            wp_username: "admin", status: "connected", client_label: null,
            capabilities: { abilities: [] }, created_at: "", updated_at: "" }
        : null;
    },
  } as unknown as SitesRepo;

  const security = {
    async latestGrade() { return { grade: "B" as const, score: 83 }; },
    async openVulns() {
      return [
        { feed_id: "v1", component: "plugin:akismet", installed_version: "5.3", severity: "critical", title: "XSS", cve: null, fixed_in: "5.4", first_seen: "" },
        { feed_id: "v2", component: "core", installed_version: "6.4", severity: "medium", title: "Info leak", cve: null, fixed_in: null, first_seen: "" },
      ];
    },
    async latestChecks() {
      return {
        runAt: "2026-08-20T00:00:00Z",
        checks: [
          { check_id: "wp_debug", result: "pass" as const },
          { check_id: "admin_username", result: "fail" as const },
          { check_id: "xmlrpc_enabled", result: "warn" as const },
        ],
      };
    },
    async uptimeSummary() { return { latestOk: true, responseMs: 210, sslDays: 62, uptime24h: 99.9 }; },
  } as unknown as SecurityRepo;

  const seo = {
    async latestBySource() {
      return {
        rankmath_audit: { taken_at: "2026-08-21T00:00:00Z", source: "rankmath_audit" as const,
          payload: { status: "ok", data: { score: 72, grade: "good", findings: [
            { test_id: "t1", category: "basic", status: "fail", title: "Titles missing keywords" },
            { test_id: "t2", category: "basic", status: "ok", title: "Sitemaps" },
          ] } } },
        rankmath_scores: { taken_at: "2026-08-21T00:00:00Z", source: "rankmath_scores" as const,
          payload: { status: "ok", data: { pages: [
            { post_id: 2, title: "Low page", keyword: "k", score: 15, grade: "bad" },
            { post_id: 1, title: "Good page", keyword: "k", score: 90, grade: "good" },
          ] } } },
        keywords: { taken_at: "2026-08-21T00:00:00Z", source: "keywords" as const,
          payload: { status: "ok", data: { connected: true, keywords: [
            { keyword: "el nido", clicks: 120, impressions: 4000, ctr: 3, position: 8.4 },
          ] } } },
        psi: { taken_at: "2026-08-21T00:00:00Z", source: "psi" as const,
          payload: { status: "ok", data: { mobile: { performance: 55 }, desktop: { performance: 91 }, url: "x" } } },
        ai_visibility: { taken_at: "2026-08-21T00:00:00Z", source: "ai_visibility" as const,
          payload: { status: "ok", data: { brands: [{ id: "b", name: "El Nido Guide", score: 41 }] } } },
      };
    },
  } as unknown as SeoRepo;

  const geogrid = {
    async getConfigBySite() {
      return { id: "cfg", site_id: "site-1", business_name: "El Nido Guide", place_ref: null,
        keywords: ["tours"], grid_size: 3, spacing_m: 1000, center_lat: 11, center_lng: 119,
        provider: "stub" as const, created_at: "" };
    },
    async latestPerKeyword() {
      return {
        tours: { id: "s1", config_id: "cfg", run_at: "2026-08-22T00:00:00Z", keyword: "tours",
          points: [
            { idx: 0, lat: 1, lng: 1, rank: 4 },
            { idx: 1, lat: 1, lng: 1, rank: 8 },
            { idx: 2, lat: 1, lng: 1, rank: null },
          ] },
      };
    },
  } as unknown as GeoGridRepo;

  const snapshots = {
    async latestSnapshot() {
      return {
        taken_at: "2026-08-23T00:00:00Z",
        payload: {
          collected_at: "2026-08-23T00:00:00Z", wp_version: "6.7.1", php_version: "8.2",
          core_update: "6.8",
          plugins: [
            { file: "a/a.php", name: "a", version: "1", status: "active", update: "available", update_version: "2" },
            { file: "b/b.php", name: "b", version: "1", status: "active", update: "none", update_version: null },
          ],
          themes: [],
        },
      };
    },
  } as unknown as SnapshotsRepo;

  return { sites, security, seo, geogrid, snapshots, ...over };
}

describe("gatherReportData", () => {
  it("builds every requested section from stored data", async () => {
    const data = await gatherReportData(deps(), "site-1", REPORT_SECTIONS, 30);

    expect(data.meta).toMatchObject({ siteName: "El Nido Guide", siteUrl: "https://elnido.test" });
    expect(data.meta.sections).toEqual(REPORT_SECTIONS);
    expect(new Date(data.meta.periodEnd).getTime())
      .toBeGreaterThan(new Date(data.meta.periodStart).getTime());

    expect(data.security).toMatchObject({
      grade: "B", score: 83, openVulns: 2, criticalVulns: 1, uptime24h: 99.9, sslDays: 62,
    });
    // only non-passing checks are worth a client's attention
    expect(data.security!.failedChecks.map((c) => c.id)).toEqual(["admin_username", "xmlrpc_enabled"]);

    expect(data.seo).toMatchObject({
      auditScore: 72, grade: "good", keywordsConnected: true, psiMobile: 55, psiDesktop: 91,
    });
    expect(data.seo!.failingFindings.map((f) => f.title)).toEqual(["Titles missing keywords"]);
    expect(data.seo!.worstPages[0]).toMatchObject({ title: "Low page", score: 15 });
    expect(data.seo!.topKeywords[0]).toMatchObject({ keyword: "el nido", clicks: 120 });
    expect(data.seo!.brands[0]).toMatchObject({ name: "El Nido Guide", score: 41 });

    expect(data.geogrid).toMatchObject({ businessName: "El Nido Guide" });
    expect(data.geogrid!.keywords[0]).toMatchObject({
      keyword: "tours", averageRank: 6, coverage: 67, measured: 3, total: 3,
    });

    expect(data.inventory).toMatchObject({
      wpVersion: "6.7.1", phpVersion: "8.2", pluginCount: 2, coreUpdate: "6.8",
    });
    expect(data.inventory!.pendingUpdates).toBe(2); // 1 plugin + core
  });

  it("returns null for sections that were not requested", async () => {
    const data = await gatherReportData(deps(), "site-1", ["security"], 30);
    expect(data.security).not.toBeNull();
    expect(data.seo).toBeNull();
    expect(data.geogrid).toBeNull();
    expect(data.inventory).toBeNull();
  });

  it("renders empty sections instead of throwing when nothing is stored", async () => {
    const empty = deps({
      security: {
        async latestGrade() { return null; },
        async openVulns() { return []; },
        async latestChecks() { return null; },
        async uptimeSummary() { return { latestOk: null, responseMs: null, sslDays: null, uptime24h: null }; },
      } as unknown as SecurityRepo,
      seo: { async latestBySource() { return {}; } } as unknown as SeoRepo,
      geogrid: {
        async getConfigBySite() { return null; },
        async latestPerKeyword() { return {}; },
      } as unknown as GeoGridRepo,
      snapshots: { async latestSnapshot() { return null; } } as unknown as SnapshotsRepo,
    });
    const data = await gatherReportData(empty, "site-1", REPORT_SECTIONS, 30);
    expect(data.security).toMatchObject({ grade: null, openVulns: 0, failedChecks: [] });
    expect(data.seo).toMatchObject({ auditScore: null, topKeywords: [], keywordsConnected: false });
    expect(data.geogrid).toMatchObject({ businessName: null, keywords: [] });
    expect(data.inventory).toMatchObject({ wpVersion: null, pluginCount: 0, pendingUpdates: 0 });
  });

  it("throws for an unknown site", async () => {
    await expect(gatherReportData(deps(), "nope", ["security"], 30)).rejects.toThrow(/not found/i);
  });

  // Review finding #1: the client-facing PDF must be able to tell "measured
  // everything, ranked nowhere" apart from "measured almost nothing" —
  // coverage() alone returns a bare percentage that can't distinguish them
  // (80 of 81 lookups failed, the 1 survivor ranked #3 -> coverage() = 100).
  it("carries measured/total alongside coverage so a near-total failure isn't reported as full visibility", async () => {
    const points = [
      { idx: 0, lat: 1, lng: 1, rank: 3, measured: true },
      ...Array.from({ length: 80 }, (_, i) => ({ idx: i + 1, lat: 1, lng: 1, rank: null, measured: false })),
    ];
    const data = await gatherReportData(
      deps({
        geogrid: {
          async getConfigBySite() {
            return { id: "cfg", site_id: "site-1", business_name: "El Nido Guide", place_ref: null,
              keywords: ["tours"], grid_size: 9, spacing_m: 1000, center_lat: 11, center_lng: 119,
              provider: "n8n" as const, created_at: "" };
          },
          async latestPerKeyword() {
            return { tours: { id: "s1", config_id: "cfg", run_at: "2026-08-22T00:00:00Z", keyword: "tours", points } };
          },
        } as unknown as GeoGridRepo,
      }),
      "site-1", ["geogrid"], 30,
    );
    expect(data.geogrid!.keywords[0]).toMatchObject({
      averageRank: 3, coverage: 100, measured: 1, total: 81,
    });
  });
});
