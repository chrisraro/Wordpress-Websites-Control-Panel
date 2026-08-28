# Phase 7: Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a branded multi-page PDF per site — security, SEO/AEO, GeoGrid, and site inventory — stored privately in Supabase Storage and shareable with clients through a revocable public link.

**Architecture:** A pure `gatherReportData` function reads the snapshots the earlier phases already store (no live site calls, so reports are fast and never fail on an unreachable site). `@react-pdf/renderer` turns that data into a PDF buffer, which is uploaded to a private `reports` bucket; a `reports` row records the sections, period, storage path, and a 128-bit share token. `/r/[token]` is a public page that renders the summary and streams the PDF through an authenticated-by-token route — the storage bucket itself is never public. A monthly `report_generate` job does the same thing unattended.

**Tech Stack:** Existing stack + `@react-pdf/renderer@4.9.0` (already installed; **verified working**: a route rendered a real `%PDF-1.3` under `next start` in this repo).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md` §6.4. Reports read **only stored snapshots** — they never open an MCP client.
- **App Router gotcha (learned the hard way):** folders whose name starts with `_` are private and are NOT routed. Never name a route folder `_something`. Route handlers must be `route.ts` — JSX belongs in a separate `.tsx` module the route imports (`renderToBuffer` is called from the `.ts` file).
- PDF rendering is Node-only: every route/action that renders sets `export const runtime = "nodejs"`.
- Storage: private bucket `reports` (migration `0004`). Files at `reports/<siteId>/<reportId>.pdf`. The bucket is never public; downloads go through `/r/[token]/file`, which validates the token server-side and streams the object using the service-role client.
- Share tokens: 32 hex chars from `randomBytes(16)` (128 bits). Revoking sets `share_token = null`, which must make both `/r/[token]` and its file route 404.
- `/r/*` is already public in middleware. The share page must never expose site credentials, MCP endpoints, or internal ids beyond what a client should see (site name, URL, metrics).
- Every user-initiated generation logs activity `site.report_generate`; revocation logs `site.report_revoke`. Job-generated reports set `auto = true` and are not activity-logged.
- Jobs: new `JobType` `"report_generate"`, payload `{ sections: string[], period_days: number, actor?: string }`. The nightly enqueue queues one per site on the **1st of the month** when no `auto` report exists for the current month.
- Sections are exactly: `security | seo | geogrid | inventory`. A section with no stored data renders an honest "no data yet" line — it never blocks the report.
- Responsive + a11y as established (`overflow-x-auto` tables, `min-h-10` targets, labelled inputs, `aria-live` errors). Impeccable audit after the UI tasks.
- Commit after every task; PowerShell-safe commands.

## File Structure (new/changed)

```
supabase/migrations/0004_storage_reports.sql   # private reports bucket
src/services/reports/types.ts                  # ReportSection, ReportData, ReportMeta
src/services/reports/gather.ts                 # gatherReportData (pure aggregation)
src/services/reports/repo.ts                   # ReportsRepo + supabase impl
src/services/reports/document.tsx              # ReportDocument (react-pdf JSX)
src/services/reports/generate.ts               # generateReport orchestrator
src/services/jobs/{types,handlers}.ts          # + report_generate
src/app/api/cron/enqueue/route.ts              # + monthly rule
src/app/(dashboard)/sites/[id]/reports-actions.ts
src/app/(dashboard)/sites/[id]/reports/page.tsx
src/app/(dashboard)/sites/[id]/reports/generate-form.tsx
src/app/(dashboard)/sites/[id]/tabs.tsx        # Reports → LIVE (COMING becomes empty)
src/app/r/[token]/page.tsx                     # public share page
src/app/r/[token]/file/route.ts                # token-gated PDF stream
README.md
tests/{report-gather,report-generate}.test.ts
```

---

### Task 1: Storage migration + report types (TDD on helpers)

**Files:**
- Create: `supabase/migrations/0004_storage_reports.sql`, `src/services/reports/types.ts`
- Test: `tests/report-gather.test.ts` (types portion; extended in Task 2)

**Interfaces:**
- Produces:
```ts
export type ReportSection = "security" | "seo" | "geogrid" | "inventory";
export const REPORT_SECTIONS: ReportSection[];
export function parseSections(raw: unknown): ReportSection[];   // filters unknown values, dedupes, keeps REPORT_SECTIONS order; [] when nothing valid
export interface ReportMeta {
  siteName: string; siteUrl: string; generatedAt: string;
  periodStart: string; periodEnd: string; sections: ReportSection[];
}
export interface SecuritySection { grade: string | null; score: number | null; openVulns: number; criticalVulns: number; failedChecks: Array<{ id: string; result: string }>; uptime24h: number | null; sslDays: number | null; scannedAt: string | null }
export interface SeoSection { auditScore: number | null; grade: string | null; failingFindings: Array<{ title: string; status: string }>; worstPages: Array<{ title: string; score: number | null }>; keywordsConnected: boolean; topKeywords: Array<{ keyword: string; clicks: number; position: number }>; psiMobile: number | null; psiDesktop: number | null; brands: Array<{ name: string; score: number | null }>; scannedAt: string | null }
export interface GeoGridSection { businessName: string | null; keywords: Array<{ keyword: string; averageRank: number | null; coverage: number; runAt: string }> }
export interface InventorySection { wpVersion: string | null; phpVersion: string | null; pluginCount: number; pendingUpdates: number; coreUpdate: string | null; collectedAt: string | null }
export interface ReportData {
  meta: ReportMeta;
  security: SecuritySection | null;
  seo: SeoSection | null;
  geogrid: GeoGridSection | null;
  inventory: InventorySection | null;
}
```

- [ ] **Step 1: Write the migration**

`supabase/migrations/0004_storage_reports.sql`:
```sql
-- Private bucket for generated report PDFs. Clients never touch storage
-- directly: /r/<token>/file validates the share token and streams the object
-- with the service-role client.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reports', 'reports', false, 26214400, array['application/pdf'])
on conflict (id) do nothing;
```

- [ ] **Step 2: Write the failing test**

`tests/report-gather.test.ts` (first block only — Task 2 appends to this file):
```ts
import { describe, it, expect } from "vitest";
import { REPORT_SECTIONS, parseSections } from "@/services/reports/types";

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
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- tests/report-gather.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement types.ts**

`src/services/reports/types.ts`:
```ts
export type ReportSection = "security" | "seo" | "geogrid" | "inventory";

export const REPORT_SECTIONS: ReportSection[] = ["security", "seo", "geogrid", "inventory"];

export function parseSections(raw: unknown): ReportSection[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((v): v is string => typeof v === "string"));
  return REPORT_SECTIONS.filter((s) => wanted.has(s));
}

export interface ReportMeta {
  siteName: string;
  siteUrl: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  sections: ReportSection[];
}

export interface SecuritySection {
  grade: string | null;
  score: number | null;
  openVulns: number;
  criticalVulns: number;
  failedChecks: Array<{ id: string; result: string }>;
  uptime24h: number | null;
  sslDays: number | null;
  scannedAt: string | null;
}

export interface SeoSection {
  auditScore: number | null;
  grade: string | null;
  failingFindings: Array<{ title: string; status: string }>;
  worstPages: Array<{ title: string; score: number | null }>;
  keywordsConnected: boolean;
  topKeywords: Array<{ keyword: string; clicks: number; position: number }>;
  psiMobile: number | null;
  psiDesktop: number | null;
  brands: Array<{ name: string; score: number | null }>;
  scannedAt: string | null;
}

export interface GeoGridSection {
  businessName: string | null;
  keywords: Array<{ keyword: string; averageRank: number | null; coverage: number; runAt: string }>;
}

export interface InventorySection {
  wpVersion: string | null;
  phpVersion: string | null;
  pluginCount: number;
  pendingUpdates: number;
  coreUpdate: string | null;
  collectedAt: string | null;
}

export interface ReportData {
  meta: ReportMeta;
  security: SecuritySection | null;
  seo: SeoSection | null;
  geogrid: GeoGridSection | null;
  inventory: InventorySection | null;
}
```

- [ ] **Step 5: Run to verify pass, apply migration, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.
Apply `0004_storage_reports.sql` in Supabase (SQL editor or `npx supabase db push`); if unavailable in this environment, note it as pending user action.

```powershell
git add supabase/migrations/0004_storage_reports.sql src/services/reports/types.ts tests/report-gather.test.ts; git commit -m "feat: reports storage bucket and section types"
```

---

### Task 2: Report data aggregation (TDD)

**Files:**
- Create: `src/services/reports/gather.ts`
- Modify: `tests/report-gather.test.ts` (append)

**Interfaces:**
- Consumes: `SecurityRepo` (`latestGrade`, `openVulns`, `latestChecks`, `uptimeSummary`), `SeoRepo` (`latestBySource`), `GeoGridRepo` (`getConfigBySite`, `latestPerKeyword`), `SnapshotsRepo` (`latestSnapshot`), `SitesRepo` (`getSite`), `pendingUpdates`, `averageRank`, `coverage`.
- Produces:
```ts
export interface GatherDeps {
  sites: SitesRepo; security: SecurityRepo; seo: SeoRepo;
  geogrid: GeoGridRepo; snapshots: SnapshotsRepo;
}
export async function gatherReportData(
  deps: GatherDeps, siteId: string, sections: ReportSection[], periodDays: number,
): Promise<ReportData>;
// throws when the site is missing; unselected sections are null; a section with
// no stored data still returns its object with empty/null fields (never throws)
```

- [ ] **Step 1: Write the failing tests (append to tests/report-gather.test.ts)**

```ts
import { gatherReportData, type GatherDeps } from "@/services/reports/gather";
import type { SitesRepo } from "@/services/sites/repo";
import type { SecurityRepo } from "@/services/security/repo";
import type { SeoRepo } from "@/services/seo/repo";
import type { GeoGridRepo } from "@/services/geogrid/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";

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
          core_update: "6.8", admin_users: [],
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
    expect(data.geogrid!.keywords[0]).toMatchObject({ keyword: "tours", averageRank: 6, coverage: 67 });

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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/report-gather.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/services/reports/gather.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.

```powershell
git add src/services/reports/gather.ts tests/report-gather.test.ts; git commit -m "feat: report data aggregation from stored snapshots"
```

---

### Task 3: PDF document

**Files:**
- Create: `src/services/reports/document.tsx`

**Interfaces:**
- Consumes: `ReportData` and section types (Task 1).
- Produces: `export function ReportDocument(data: ReportData): React.ReactElement;`
  (a plain function returning the `<Document>` element — called as `ReportDocument(data)` from a `.ts` file, so the route never needs JSX.)

- [ ] **Step 1: Implement**

`src/services/reports/document.tsx`:
```tsx
import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { ReportData } from "./types";

const c = {
  ink: "#0f172a", muted: "#64748b", line: "#e2e8f0",
  good: "#16a34a", warn: "#ca8a04", bad: "#dc2626",
};

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 56, paddingHorizontal: 44, fontSize: 10, color: c.ink },
  brandBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end",
    borderBottomWidth: 2, borderBottomColor: c.ink, paddingBottom: 8, marginBottom: 18 },
  brand: { fontSize: 16, fontWeight: 700 },
  brandMeta: { fontSize: 9, color: c.muted, textAlign: "right" },
  h1: { fontSize: 22, marginBottom: 4 },
  sub: { fontSize: 10, color: c.muted, marginBottom: 22 },
  h2: { fontSize: 13, fontWeight: 700, marginTop: 18, marginBottom: 8,
    borderBottomWidth: 1, borderBottomColor: c.line, paddingBottom: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  label: { color: c.muted },
  tiles: { flexDirection: "row", gap: 8, marginBottom: 8 },
  tile: { flex: 1, borderWidth: 1, borderColor: c.line, borderRadius: 4, padding: 8, alignItems: "center" },
  tileValue: { fontSize: 15, fontWeight: 700 },
  tileLabel: { fontSize: 8, color: c.muted, marginTop: 2 },
  li: { flexDirection: "row", paddingVertical: 2 },
  bullet: { width: 10, color: c.muted },
  empty: { color: c.muted, fontStyle: "italic", paddingVertical: 4 },
  footer: { position: "absolute", bottom: 24, left: 44, right: 44, flexDirection: "row",
    justifyContent: "space-between", borderTopWidth: 1, borderTopColor: c.line,
    paddingTop: 6, fontSize: 8, color: c.muted },
});

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", {
  day: "2-digit", month: "short", year: "numeric",
}) : "—");

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <View style={s.tile}>
      <Text style={s.tileValue}>{value}</Text>
      <Text style={s.tileLabel}>{label}</Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <Text style={s.empty}>{empty}</Text>;
  return (
    <View>
      {items.map((text, i) => (
        <View style={s.li} key={i}>
          <Text style={s.bullet}>•</Text>
          <Text>{text}</Text>
        </View>
      ))}
    </View>
  );
}

export function ReportDocument(data: ReportData): React.ReactElement {
  const { meta, security, seo, geogrid, inventory } = data;
  return (
    <Document
      title={`${meta.siteName} — website report`}
      author="OCS"
      subject={`Website report for ${meta.siteName}`}
    >
      <Page size="A4" style={s.page}>
        <View style={s.brandBar}>
          <Text style={s.brand}>OCS — Website Report</Text>
          <Text style={s.brandMeta}>
            {fmtDate(meta.periodStart)} – {fmtDate(meta.periodEnd)}
            {"\n"}Generated {fmtDate(meta.generatedAt)}
          </Text>
        </View>

        <Text style={s.h1}>{meta.siteName}</Text>
        <Text style={s.sub}>{meta.siteUrl}</Text>

        {security && (
          <View>
            <Text style={s.h2}>Security</Text>
            <View style={s.tiles}>
              <Tile value={security.grade ?? "—"} label="Grade" />
              <Tile value={security.score === null ? "—" : `${security.score}/100`} label="Score" />
              <Tile value={String(security.openVulns)} label="Known vulnerabilities" />
              <Tile value={security.uptime24h === null ? "—" : `${security.uptime24h}%`} label="Uptime (24h)" />
            </View>
            <Row label="Critical vulnerabilities" value={String(security.criticalVulns)} />
            <Row label="SSL certificate expires in" value={security.sslDays === null ? "—" : `${security.sslDays} days`} />
            <Row label="Last scan" value={fmtDate(security.scannedAt)} />
            <Text style={{ marginTop: 8, marginBottom: 2 }}>Hardening items needing attention</Text>
            <Bullets
              items={security.failedChecks.map((c2) => `${c2.id.replace(/_/g, " ")} — ${c2.result}`)}
              empty="All hardening checks passed."
            />
          </View>
        )}

        {seo && (
          <View>
            <Text style={s.h2}>SEO &amp; AEO</Text>
            <View style={s.tiles}>
              <Tile value={seo.auditScore === null ? "—" : `${seo.auditScore}/100`} label="SEO audit" />
              <Tile value={seo.psiMobile === null ? "—" : String(seo.psiMobile)} label="Speed (mobile)" />
              <Tile value={seo.psiDesktop === null ? "—" : String(seo.psiDesktop)} label="Speed (desktop)" />
              <Tile value={String(seo.brands.length)} label="AI brands tracked" />
            </View>
            <Row label="Last scan" value={fmtDate(seo.scannedAt)} />
            <Text style={{ marginTop: 8, marginBottom: 2 }}>Issues to address</Text>
            <Bullets
              items={seo.failingFindings.map((f) => `${f.title} (${f.status})`)}
              empty="No failing SEO tests."
            />
            <Text style={{ marginTop: 8, marginBottom: 2 }}>Pages with the lowest scores</Text>
            <Bullets
              items={seo.worstPages.map((p) => `${p.title} — ${p.score ?? "unscored"}`)}
              empty="No page scores recorded."
            />
            <Text style={{ marginTop: 8, marginBottom: 2 }}>Top search queries</Text>
            <Bullets
              items={seo.topKeywords.map((k) => `${k.keyword} — ${k.clicks} clicks, position ${k.position.toFixed(1)}`)}
              empty={seo.keywordsConnected
                ? "No search impressions in this period."
                : "Google Search Console is not connected for this site."}
            />
          </View>
        )}

        <View style={s.footer} fixed>
          <Text>{meta.siteName} — confidential</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>

      {(geogrid || inventory) && (
        <Page size="A4" style={s.page}>
          <View style={s.brandBar}>
            <Text style={s.brand}>OCS — Website Report</Text>
            <Text style={s.brandMeta}>{meta.siteName}</Text>
          </View>

          {geogrid && (
            <View>
              <Text style={s.h2}>Local visibility (GeoGrid)</Text>
              <Row label="Business" value={geogrid.businessName ?? "Not configured"} />
              <Text style={{ marginTop: 8, marginBottom: 2 }}>Average rank by keyword</Text>
              <Bullets
                items={geogrid.keywords.map((k) =>
                  `${k.keyword} — average rank ${k.averageRank ?? "not ranked"}, visible at ${k.coverage}% of locations (${fmtDate(k.runAt)})`)}
                empty="No GeoGrid scans recorded yet."
              />
            </View>
          )}

          {inventory && (
            <View>
              <Text style={s.h2}>Site inventory</Text>
              <View style={s.tiles}>
                <Tile value={inventory.wpVersion ?? "—"} label="WordPress" />
                <Tile value={inventory.phpVersion ?? "—"} label="PHP" />
                <Tile value={String(inventory.pluginCount)} label="Plugins" />
                <Tile value={String(inventory.pendingUpdates)} label="Pending updates" />
              </View>
              <Row label="WordPress core update available" value={inventory.coreUpdate ?? "Up to date"} />
              <Row label="Inventory collected" value={fmtDate(inventory.collectedAt)} />
            </View>
          )}

          <View style={s.footer} fixed>
            <Text>{meta.siteName} — confidential</Text>
            <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
          </View>
        </Page>
      )}
    </Document>
  );
}
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit` → 0 errors; `npm test` → green; `npm run build` → success.

```powershell
git add src/services/reports/document.tsx; git commit -m "feat: branded report PDF document"
```

---

### Task 4: Reports repo + generate orchestrator (TDD)

**Files:**
- Create: `src/services/reports/repo.ts`, `src/services/reports/generate.ts`
- Test: `tests/report-generate.test.ts`

**Interfaces:**
- Consumes: `gatherReportData` (T2), `ReportDocument` (T3), `renderToBuffer` from `@react-pdf/renderer`.
- Produces:
```ts
// repo.ts
export interface ReportRow {
  id: string; site_id: string; generated_at: string; sections: string[];
  period_start: string | null; period_end: string | null;
  storage_path: string; share_token: string | null; auto: boolean;
}
export interface ReportsRepo {
  insert(row: { site_id: string; sections: string[]; period_start: string; period_end: string; storage_path: string; share_token: string; auto: boolean }): Promise<ReportRow>;
  listForSite(siteId: string, limit?: number): Promise<ReportRow[]>;
  getByToken(token: string): Promise<ReportRow | null>;
  revoke(id: string): Promise<void>;                       // share_token -> null
  autoExistsSince(siteId: string, sinceIso: string): Promise<boolean>;
}
export function supabaseReportsRepo(db: SupabaseClient): ReportsRepo;

export interface ReportStorage {
  upload(path: string, pdf: Uint8Array): Promise<void>;
  download(path: string): Promise<Uint8Array>;
}
export function supabaseReportStorage(db: SupabaseClient): ReportStorage;

// generate.ts
export interface GenerateDeps extends GatherDeps { reports: ReportsRepo; storage: ReportStorage; render?: (data: ReportData) => Promise<Uint8Array> }
export async function generateReport(
  deps: GenerateDeps, siteId: string, sections: ReportSection[], periodDays: number, auto: boolean,
): Promise<{ report: ReportRow; bytes: number }>;
// gathers → renders → uploads to reports/<siteId>/<uuid>.pdf → inserts the row with a fresh token
export function newShareToken(): string;   // 32 hex chars
```

- [ ] **Step 1: Write the failing tests**

`tests/report-generate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { generateReport, newShareToken, type GenerateDeps } from "@/services/reports/generate";
import type { ReportRow, ReportsRepo, ReportStorage } from "@/services/reports/repo";
import type { ReportData } from "@/services/reports/types";
import type { SitesRepo } from "@/services/sites/repo";
import type { SecurityRepo } from "@/services/security/repo";
import type { SeoRepo } from "@/services/seo/repo";
import type { GeoGridRepo } from "@/services/geogrid/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";

function fakes() {
  const uploaded: Array<{ path: string; bytes: number }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const rendered: ReportData[] = [];

  const sites = {
    async getSite(id: string) {
      return id === "site-1"
        ? { id, name: "Test Site", url: "https://test.example", mcp_endpoint: "x",
            wp_username: "admin", status: "connected", client_label: null,
            capabilities: { abilities: [] }, created_at: "", updated_at: "" }
        : null;
    },
  } as unknown as SitesRepo;
  const security = {
    async latestGrade() { return null; },
    async openVulns() { return []; },
    async latestChecks() { return null; },
    async uptimeSummary() { return { latestOk: null, responseMs: null, sslDays: null, uptime24h: null }; },
  } as unknown as SecurityRepo;
  const seo = { async latestBySource() { return {}; } } as unknown as SeoRepo;
  const geogrid = {
    async getConfigBySite() { return null; },
    async latestPerKeyword() { return {}; },
  } as unknown as GeoGridRepo;
  const snapshots = { async latestSnapshot() { return null; } } as unknown as SnapshotsRepo;

  const reports: ReportsRepo = {
    async insert(row) {
      inserted.push(row);
      return { id: "rep-1", generated_at: "2026-08-28T00:00:00Z", ...row } as ReportRow;
    },
    async listForSite() { return []; },
    async getByToken() { return null; },
    async revoke() {},
    async autoExistsSince() { return false; },
  };
  const storage: ReportStorage = {
    async upload(path, pdf) { uploaded.push({ path, bytes: pdf.length }); },
    async download() { return new Uint8Array([1, 2, 3]); },
  };
  const render = async (data: ReportData) => {
    rendered.push(data);
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]);   // "%PDF"
  };

  const deps: GenerateDeps = { sites, security, seo, geogrid, snapshots, reports, storage, render };
  return { deps, uploaded, inserted, rendered };
}

describe("newShareToken", () => {
  it("returns 32 hex characters that differ each call", () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("generateReport", () => {
  it("gathers, renders, uploads, and records the report", async () => {
    const f = fakes();
    const res = await generateReport(f.deps, "site-1", ["security", "inventory"], 30, false);

    expect(f.rendered).toHaveLength(1);
    expect(f.rendered[0].meta.siteName).toBe("Test Site");
    expect(f.rendered[0].security).not.toBeNull();
    expect(f.rendered[0].seo).toBeNull();

    expect(f.uploaded).toHaveLength(1);
    expect(f.uploaded[0].path).toMatch(/^site-1\/[0-9a-f-]{36}\.pdf$/);
    expect(f.uploaded[0].bytes).toBe(4);

    expect(f.inserted[0]).toMatchObject({
      site_id: "site-1", sections: ["security", "inventory"], auto: false,
    });
    expect(String(f.inserted[0].share_token)).toMatch(/^[0-9a-f]{32}$/);
    expect(f.inserted[0].storage_path).toBe(f.uploaded[0].path);

    expect(res.bytes).toBe(4);
    expect(res.report.id).toBe("rep-1");
  });

  it("marks automatic reports", async () => {
    const f = fakes();
    await generateReport(f.deps, "site-1", ["security"], 30, true);
    expect(f.inserted[0]).toMatchObject({ auto: true });
  });

  it("rejects an empty section list", async () => {
    const f = fakes();
    await expect(generateReport(f.deps, "site-1", [], 30, false)).rejects.toThrow(/section/i);
  });

  it("does not record a report when the upload fails", async () => {
    const f = fakes();
    f.deps.storage.upload = async () => { throw new Error("storage down"); };
    await expect(generateReport(f.deps, "site-1", ["security"], 30, false)).rejects.toThrow("storage down");
    expect(f.inserted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/report-generate.test.ts` → FAIL.

- [ ] **Step 3: Implement repo.ts**

`src/services/reports/repo.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ReportRow {
  id: string;
  site_id: string;
  generated_at: string;
  sections: string[];
  period_start: string | null;
  period_end: string | null;
  storage_path: string;
  share_token: string | null;
  auto: boolean;
}

export interface ReportsRepo {
  insert(row: {
    site_id: string; sections: string[]; period_start: string; period_end: string;
    storage_path: string; share_token: string; auto: boolean;
  }): Promise<ReportRow>;
  listForSite(siteId: string, limit?: number): Promise<ReportRow[]>;
  getByToken(token: string): Promise<ReportRow | null>;
  revoke(id: string): Promise<void>;
  autoExistsSince(siteId: string, sinceIso: string): Promise<boolean>;
}

const COLUMNS =
  "id,site_id,generated_at,sections,period_start,period_end,storage_path,share_token,auto";

export function supabaseReportsRepo(db: SupabaseClient): ReportsRepo {
  return {
    async insert(row) {
      const { data, error } = await db.from("reports").insert(row).select(COLUMNS).single();
      if (error) throw new Error(`reports.insert failed: ${error.message}`, { cause: error });
      return data as ReportRow;
    },
    async listForSite(siteId, limit = 20) {
      const { data, error } = await db.from("reports").select(COLUMNS)
        .eq("site_id", siteId).order("generated_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`reports.listForSite failed: ${error.message}`, { cause: error });
      return (data ?? []) as ReportRow[];
    },
    async getByToken(token) {
      const { data, error } = await db.from("reports").select(COLUMNS)
        .eq("share_token", token).maybeSingle();
      if (error) throw new Error(`reports.getByToken failed: ${error.message}`, { cause: error });
      return (data as ReportRow) ?? null;
    },
    async revoke(id) {
      const { error } = await db.from("reports").update({ share_token: null }).eq("id", id);
      if (error) throw new Error(`reports.revoke failed: ${error.message}`, { cause: error });
    },
    async autoExistsSince(siteId, sinceIso) {
      const { count, error } = await db.from("reports").select("id", { head: true, count: "exact" })
        .eq("site_id", siteId).eq("auto", true).gte("generated_at", sinceIso);
      if (error) throw new Error(`reports.autoExistsSince failed: ${error.message}`, { cause: error });
      return (count ?? 0) > 0;
    },
  };
}

export interface ReportStorage {
  upload(path: string, pdf: Uint8Array): Promise<void>;
  download(path: string): Promise<Uint8Array>;
}

export function supabaseReportStorage(db: SupabaseClient): ReportStorage {
  return {
    async upload(path, pdf) {
      const { error } = await db.storage.from("reports")
        .upload(path, pdf, { contentType: "application/pdf", upsert: false });
      if (error) throw new Error(`report upload failed: ${error.message}`, { cause: error });
    },
    async download(path) {
      const { data, error } = await db.storage.from("reports").download(path);
      if (error || !data) throw new Error(`report download failed: ${error?.message ?? "missing"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
```

- [ ] **Step 4: Implement generate.ts**

`src/services/reports/generate.ts`:
```ts
import { randomBytes, randomUUID } from "node:crypto";
import { renderToBuffer } from "@react-pdf/renderer";
import { gatherReportData, type GatherDeps } from "./gather";
import { ReportDocument } from "./document";
import type { ReportsRepo, ReportRow, ReportStorage } from "./repo";
import type { ReportData, ReportSection } from "./types";

export function newShareToken(): string {
  return randomBytes(16).toString("hex");
}

export interface GenerateDeps extends GatherDeps {
  reports: ReportsRepo;
  storage: ReportStorage;
  /** Injected in tests; production renders with @react-pdf/renderer. */
  render?: (data: ReportData) => Promise<Uint8Array>;
}

async function renderPdf(data: ReportData): Promise<Uint8Array> {
  const buffer = await renderToBuffer(ReportDocument(data));
  return new Uint8Array(buffer);
}

export async function generateReport(
  deps: GenerateDeps, siteId: string, sections: ReportSection[],
  periodDays: number, auto: boolean,
): Promise<{ report: ReportRow; bytes: number }> {
  if (sections.length === 0) throw new Error("Choose at least one report section");

  const data = await gatherReportData(deps, siteId, sections, periodDays);
  const pdf = await (deps.render ?? renderPdf)(data);

  // Upload before inserting: a recorded report must always have a file behind it.
  const path = `${siteId}/${randomUUID()}.pdf`;
  await deps.storage.upload(path, pdf);

  const report = await deps.reports.insert({
    site_id: siteId,
    sections,
    period_start: data.meta.periodStart,
    period_end: data.meta.periodEnd,
    storage_path: path,
    share_token: newShareToken(),
    auto,
  });
  return { report, bytes: pdf.length };
}
```

- [ ] **Step 5: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.

```powershell
git add src/services/reports/repo.ts src/services/reports/generate.ts tests/report-generate.test.ts; git commit -m "feat: report repository, storage, and generation orchestrator"
```

---

### Task 5: Public share page + file route

**Files:**
- Create: `src/app/r/[token]/page.tsx`, `src/app/r/[token]/file/route.ts`

**Interfaces:**
- Consumes: `supabaseReportsRepo`, `supabaseReportStorage`, `createServiceSupabase`, `gatherReportData` is NOT used here (the page shows metadata only).
- Produces: public routes `/r/[token]` and `/r/[token]/file`.
- Both validate the token format (`/^[0-9a-f]{32}$/`) and 404 on unknown or revoked tokens.

- [ ] **Step 1: Implement the file route**

`src/app/r/[token]/file/route.ts`:
```ts
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseReportsRepo, supabaseReportStorage } from "@/services/reports/repo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOKEN_RE = /^[0-9a-f]{32}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!TOKEN_RE.test(token)) return new Response("Not found", { status: 404 });

  const db = createServiceSupabase();
  const report = await supabaseReportsRepo(db).getByToken(token);
  // A revoked report has share_token = null, so getByToken cannot return it.
  if (!report) return new Response("Not found", { status: 404 });

  let pdf: Uint8Array;
  try {
    pdf = await supabaseReportStorage(db).download(report.storage_path);
  } catch {
    return new Response("Report file unavailable", { status: 404 });
  }

  const filename = `report-${report.generated_at.slice(0, 10)}.pdf`;
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
```

- [ ] **Step 2: Implement the share page**

`src/app/r/[token]/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseReportsRepo } from "@/services/reports/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";

export const dynamic = "force-dynamic";

const TOKEN_RE = /^[0-9a-f]{32}$/;

const SECTION_LABELS: Record<string, string> = {
  security: "Security", seo: "SEO & AEO", geogrid: "Local visibility", inventory: "Site inventory",
};

export default async function SharedReportPage({
  params,
}: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) notFound();

  const db = createServiceSupabase();
  const report = await supabaseReportsRepo(db).getByToken(token);
  if (!report) notFound();

  // Only the site's display name is shown — never its credentials or endpoint.
  const site = await supabaseSitesRepo(db).getSite(report.site_id);
  const period = report.period_start && report.period_end
    ? `${new Date(report.period_start).toLocaleDateString()} – ${new Date(report.period_end).toLocaleDateString()}`
    : null;

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-6 border-b pb-4">
        <p className="text-sm text-slate-500">OCS — Website Report</p>
        <h1 className="text-2xl font-semibold">{site?.name ?? "Website report"}</h1>
        {site?.url && (
          <a href={site.url} target="_blank" rel="noreferrer"
            className="break-all text-sm text-slate-500 underline">{site.url}</a>
        )}
      </div>

      <dl className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white p-3">
          <dt className="text-xs text-slate-500">Generated</dt>
          <dd className="font-medium">{new Date(report.generated_at).toLocaleDateString()}</dd>
        </div>
        <div className="rounded-lg border bg-white p-3">
          <dt className="text-xs text-slate-500">Period</dt>
          <dd className="font-medium">{period ?? "—"}</dd>
        </div>
        <div className="rounded-lg border bg-white p-3">
          <dt className="text-xs text-slate-500">Sections</dt>
          <dd className="font-medium">{report.sections.length}</dd>
        </div>
      </dl>

      <p className="mb-2 text-sm font-medium">This report covers</p>
      <ul className="mb-6 flex flex-wrap gap-2">
        {report.sections.map((s) => (
          <li key={s} className="rounded-full border bg-white px-3 py-1 text-sm">
            {SECTION_LABELS[s] ?? s}
          </li>
        ))}
      </ul>

      <a href={`/r/${token}/file`} target="_blank" rel="noreferrer"
        className="inline-flex min-h-10 items-center rounded bg-slate-900 px-4 py-2 text-sm text-white">
        Open the PDF report
      </a>

      <p className="mt-8 text-xs text-slate-400">
        This link was shared with you by OCS and can be revoked at any time.
      </p>
    </main>
  );
}
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — green, and confirm `/r/[token]` and `/r/[token]/file` appear in the build's route list.

```powershell
git add "src/app/r"; git commit -m "feat: public share page and token-gated report download"
```

---

### Task 6: Reports tab, actions, and job wiring

**Files:**
- Create: `src/app/(dashboard)/sites/[id]/reports-actions.ts`, `src/app/(dashboard)/sites/[id]/reports/page.tsx`, `src/app/(dashboard)/sites/[id]/reports/generate-form.tsx`
- Modify: `src/app/(dashboard)/sites/[id]/tabs.tsx`, `src/services/jobs/types.ts`, `src/services/jobs/handlers.ts`, `src/app/api/cron/enqueue/route.ts`

**Interfaces:**
- Consumes: `generateReport` (T4), `supabaseReportsRepo`/`supabaseReportStorage`, all four data repos, `parseSections` (T1), `ManageForm`.
- Produces:
```ts
// reports-actions.ts ("use server", runtime nodejs)
export async function generateReportAction(
  siteId: string, _prev: { ok: boolean; error?: string } | null, formData: FormData,
): Promise<{ ok: boolean; error?: string }>;
export async function revokeReportAction(siteId: string, reportId: string): Promise<{ ok: boolean; error?: string }>;
// generate-form.tsx (client): <GenerateReportForm siteId />
// jobs: JobType gains "report_generate"; handler generates with auto=true
```
The action reads `sections` (multiple checkbox values via `formData.getAll("sections")`) and `period_days`; `useActionState` calls it as `(prevState, formData)` — the signature above already accounts for the bound `siteId`.

- [ ] **Step 1: Implement the actions**

`src/app/(dashboard)/sites/[id]/reports-actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { generateReport } from "@/services/reports/generate";
import { supabaseReportsRepo, supabaseReportStorage } from "@/services/reports/repo";
import { parseSections } from "@/services/reports/types";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

export const runtime = "nodejs";

function reportDeps(db: ReturnType<typeof createServiceSupabase>) {
  return {
    sites: supabaseSitesRepo(db),
    security: supabaseSecurityRepo(db),
    seo: supabaseSeoRepo(db),
    geogrid: supabaseGeoGridRepo(db),
    snapshots: supabaseSnapshotsRepo(db),
    reports: supabaseReportsRepo(db),
    storage: supabaseReportStorage(db),
  };
}

export async function generateReportAction(
  siteId: string,
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  if (!formData || typeof formData.getAll !== "function") {
    return { ok: false, error: "Form data missing — please resubmit" };
  }
  const sections = parseSections(formData.getAll("sections").map(String));
  if (sections.length === 0) return { ok: false, error: "Choose at least one section" };
  const periodDays = Number(String(formData.get("period_days") ?? "30"));
  if (!Number.isFinite(periodDays) || periodDays < 1 || periodDays > 365) {
    return { ok: false, error: "Period must be between 1 and 365 days" };
  }

  const db = createServiceSupabase();
  try {
    await generateReport(reportDeps(db), siteId, sections, periodDays, false);
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.report_generate",
      detail: { sections, period_days: periodDays },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Report generation failed" };
  }
  revalidatePath(`/sites/${siteId}/reports`);
  return { ok: true };
}

export async function revokeReportAction(
  siteId: string, reportId: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const db = createServiceSupabase();
  try {
    await supabaseReportsRepo(db).revoke(reportId);
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.report_revoke", detail: { report_id: reportId },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not revoke the link" };
  }
  revalidatePath(`/sites/${siteId}/reports`);
  return { ok: true };
}
```

- [ ] **Step 2: Implement the generate form**

`src/app/(dashboard)/sites/[id]/reports/generate-form.tsx`:
```tsx
"use client";

import { useActionState } from "react";
import { generateReportAction } from "../reports-actions";

const SECTIONS = [
  { value: "security", label: "Security" },
  { value: "seo", label: "SEO & AEO" },
  { value: "geogrid", label: "Local visibility (GeoGrid)" },
  { value: "inventory", label: "Site inventory" },
] as const;

export function GenerateReportForm({ siteId }: { siteId: string }) {
  const action = generateReportAction.bind(null, siteId);
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="space-y-4 rounded-lg border bg-white p-4 shadow-sm">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Sections to include</legend>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {SECTIONS.map((s) => (
            <label key={s.value} className="flex min-h-10 items-center gap-2 text-sm">
              <input type="checkbox" name="sections" value={s.value} defaultChecked />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block text-sm font-medium sm:max-w-56">
        Reporting period
        <select name="period_days" defaultValue="30" className="min-h-10 w-full rounded border px-3 py-2">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending}
          className="min-h-10 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
          {pending ? "Generating…" : "Generate report"}
        </button>
        <p aria-live="polite" className="text-sm">
          {state && !state.ok && <span className="text-red-600">{state.error}</span>}
          {state?.ok && <span className="text-green-700">Report generated.</span>}
        </p>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Implement the Reports page**

`src/app/(dashboard)/sites/[id]/reports/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseReportsRepo } from "@/services/reports/repo";
import { SiteTabs } from "../tabs";
import { ManageForm, type ManageFormAction } from "../action-form";
import { revokeReportAction } from "../reports-actions";
import { GenerateReportForm } from "./generate-form";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const SECTION_LABELS: Record<string, string> = {
  security: "Security", seo: "SEO", geogrid: "GeoGrid", inventory: "Inventory",
};

export default async function ReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const reports = await supabaseReportsRepo(db).listForSite(id, 20);

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Reports</p>
      <SiteTabs siteId={id} active="reports" />

      <section className="mb-6">
        <h2 className="mb-2 font-medium">Generate a report</h2>
        <p className="mb-3 text-sm text-slate-500">
          Reports are built from the data already collected by scans — generating one never
          contacts the website, so it takes a few seconds.
        </p>
        <GenerateReportForm siteId={id} />
      </section>

      <section className="rounded-lg border bg-white shadow-sm">
        <h2 className="border-b px-4 py-3 font-medium">Generated reports</h2>
        {reports.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">No reports yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Generated</th>
                  <th className="px-4 py-2">Sections</th>
                  <th className="px-4 py-2">Source</th>
                  <th className="px-4 py-2">Share link</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => {
                  const revoke = revokeReportAction.bind(null, id, r.id) as unknown as ManageFormAction;
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-4 py-2">{new Date(r.generated_at).toLocaleString()}</td>
                      <td className="px-4 py-2">
                        {r.sections.map((s) => SECTION_LABELS[s] ?? s).join(", ")}
                      </td>
                      <td className="px-4 py-2">{r.auto ? "Monthly" : "Manual"}</td>
                      <td className="px-4 py-2">
                        {r.share_token ? (
                          <a href={`/r/${r.share_token}`} target="_blank" rel="noreferrer"
                            className="underline">Open</a>
                        ) : (
                          <span className="text-slate-400">Revoked</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end">
                          {r.share_token && (
                            <ManageForm action={revoke} label="Revoke link" pendingLabel="Revoking…"
                              confirmMessage="Revoke this share link? Anyone holding it will lose access." />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Tabs + job wiring**

In `src/app/(dashboard)/sites/[id]/tabs.tsx`, add reports to `LIVE` and empty `COMING`:
```ts
const LIVE = [
  { key: "overview", label: "Overview", href: (id: string) => `/sites/${id}` },
  { key: "plugins", label: "Plugins", href: (id: string) => `/sites/${id}/plugins` },
  { key: "themes", label: "Themes", href: (id: string) => `/sites/${id}/themes` },
  { key: "security", label: "Security", href: (id: string) => `/sites/${id}/security` },
  { key: "seo", label: "SEO", href: (id: string) => `/sites/${id}/seo` },
  { key: "geogrid", label: "GeoGrid", href: (id: string) => `/sites/${id}/geogrid` },
  { key: "reports", label: "Reports", href: (id: string) => `/sites/${id}/reports` },
] as const;
const COMING: string[] = [];
```
(The `COMING.map(...)` block stays; it simply renders nothing now.)

In `src/services/jobs/types.ts`:
```ts
export type JobType =
  | "snapshot_refresh" | "security_scan" | "vuln_feed_refresh"
  | "plugin_install" | "seo_scan" | "geogrid_run" | "report_generate";
```

In `src/services/jobs/handlers.ts`, add imports and one handler:
```ts
import { generateReport } from "@/services/reports/generate";
import { supabaseReportsRepo, supabaseReportStorage } from "@/services/reports/repo";
import { parseSections, REPORT_SECTIONS } from "@/services/reports/types";
```
and in the returned object:
```ts
    report_generate: async ({ job }) => {
      if (!job.site_id) throw new Error("report_generate requires site_id");
      const p = job.payload as { sections?: unknown; period_days?: unknown };
      const sections = parseSections(p.sections);
      await generateReport(
        {
          sites, snapshots, security, seo,
          geogrid: supabaseGeoGridRepo(db),
          reports: supabaseReportsRepo(db),
          storage: supabaseReportStorage(db),
        },
        job.site_id,
        sections.length > 0 ? sections : REPORT_SECTIONS,
        Number(p.period_days) > 0 ? Number(p.period_days) : 30,
        true,
      );
    },
```

In `src/app/api/cron/enqueue/route.ts`, add the monthly rule. Add the import:
```ts
import { supabaseReportsRepo } from "@/services/reports/repo";
```
and inside the per-site `Promise.all` closure, after the `seoJob` lines, add:
```ts
    // Monthly client report: only on the 1st, and only once per calendar month.
    let reportJob: { id: string } | null = null;
    const today = new Date();
    if (today.getUTCDate() === 1) {
      const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString();
      const already = await supabaseReportsRepo(db).autoExistsSince(site.id, monthStart);
      if (!already) {
        reportJob = await enqueueJob(jobs, "report_generate", site.id,
          { sections: REPORT_SECTIONS, period_days: 30 }, { dedupe: true });
      }
    }
```
extend the closure's return to `{ snapshot: Boolean(snapshot), scan: Boolean(scan), seo: Boolean(seoJob), report: Boolean(reportJob) }`, add `const reports = perSite.filter((r) => r.report).length;` beside the other counters, and include `reports` in the JSON response. Add the import `import { REPORT_SECTIONS } from "@/services/reports/types";`.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — green; confirm `/sites/[id]/reports` is in the route list.

```powershell
git add "src/app/(dashboard)" src/services/jobs src/app/api/cron/enqueue/route.ts; git commit -m "feat: reports tab, share-link management, and monthly report job"
```

---

### Task 7: Docs

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: README**

Add after the "GeoGrid" section:
```markdown
## Reports

The Reports tab builds a branded PDF from data already collected by scans —
security grade and vulnerabilities, SEO/AEO scores and issues, GeoGrid rankings,
and site inventory. Generating a report never contacts the website.

Each report gets a revocable share link (`/r/<token>`) you can send to a client:
the page shows what the report covers and serves the PDF through a token-checked
route, so the storage bucket itself stays private. Revoking a link makes both the
page and the file 404 immediately.

On the 1st of each month the nightly enqueue queues one report per site
automatically (marked "Monthly" in the table). Requires migration
`0004_storage_reports.sql` for the private `reports` bucket.
```
And extend the "Background jobs" list:
```markdown
- Monthly (1st): `report_generate` per site — a full PDF report, stored with a share link.
```

- [ ] **Step 2: Commit**

```powershell
git add README.md; git commit -m "docs: reports phase documentation"
```

---

## Self-Review Notes

- **Spec §6.4 coverage:** site + section + period selection (T6), PDF built from stored snapshots (T2-T4), Supabase Storage with private bucket (T1, T4), `reports` row with share token (T4), `/r/[token]` public page plus PDF delivery (T5), revocable tokens (T4 repo + T6 action), optional monthly auto-generation (T6). The spec's "summary" on the share page is the section list plus period rather than duplicated metrics — the PDF is the artefact, and duplicating numbers in HTML invites the two disagreeing.
- **Type consistency:** `ReportSection`/`ReportData` defined once (T1) and consumed by gather (T2), document (T3), generate (T4), actions and handler (T6); `ReportsRepo`/`ReportStorage` (T4) match the fakes in T4's tests method-for-method; `GatherDeps` is extended (not redefined) by `GenerateDeps`.
- **Judgment calls:** upload happens before the DB insert so a recorded report always has a file; `render` is injectable so tests never spin up the PDF engine (which is slow and already proven working in this repo); the share page deliberately shows no metrics beyond section names, keeping client-facing HTML free of anything that could leak site internals.
