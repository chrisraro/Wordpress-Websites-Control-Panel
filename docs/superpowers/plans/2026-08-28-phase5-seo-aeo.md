# Phase 5: SEO/AEO Insights — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An SEO tab per site showing the Rank Math site audit score with findings, per-page SEO scores, Search Console keywords, PageSpeed Insights results, an AEO (AI Visibility) panel, and score trends over time — collected by a weekly `seo_scan` job or on demand.

**Architecture:** One `seoScan` orchestrator opens a single MCP client, calls each Rank Math ability independently (a failure or timeout in one source never fails the scan — it records that source's error), plus PageSpeed Insights over HTTP. Each source is stored as its own `seo_snapshots` row (`source` column), so trends are just history per source. Capability-gated: abilities absent from `sites.capabilities.abilities` are skipped with a recorded reason.

**Tech Stack:** Existing stack. No new dependencies (trend sparklines are inline SVG).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md` §6.3 + §3.1 amendment. All WordPress access through the MCP client; **no WP-CLI**.
- **Verified ability contracts** (probed live 2026-08-28 — fixtures must match these shapes):
  - `rank-math/audit-site-seo` → `{ url, score (0-100), grade: "good"|"average"|"bad", statuses: {ok,fail,warning,info}, total_tests, last_run_at, remote_api_status, findings: [{ test_id, category, status: "ok"|"fail"|"warning"|"info", score, title, description, fix_text, kb_link }], error }`
  - `rank-math/get-seo-scores` → **array** of `{ post_id, title, keyword|null, score|null, grade: "good"|"ok"|"bad"|"na", label, last_updated }` (input `{ number_of_posts, seo_filter? }`)
  - `rank-math/get-link-report` → `{ stats: { total_internal, total_external, posts_no_internal, posts_no_external }, audit|null, upgrade|null }` — **slow: observed >10s**, give it the full timeout
  - `rank-math/get-top-keywords` → `{ keywords: [{ keyword, clicks, impressions, ctr, position, trend?, is_tracked? }], date_range, connected }` (input `{ date_range, limit }`)
  - `rank-math/get-ai-visibility-overview` → `{ summary, brands: [{ id, name, url, score|null, rank|null, avg_sentiment|null, mentions|null, citations|null, analysis_status|null, last_analyzed|null }] }` — **empty arrays are normal** when no brands are tracked
- MCP ability timeout for SEO reads: **120_000 ms** each (link report is slow). One client per scan, closed in `finally`.
- Every ability call is individually try/caught. Per-source outcome is always recorded: `ok`, `skipped` (capability missing), or `error` (message). A scan succeeds if the client connected, even if every source errored.
- PageSpeed Insights: `GOOGLE_PSI_API_KEY` is **optional** (`getOptionalEnv`). Endpoint `https://www.googleapis.com/pagespeedonline/v5/runPagespeed`; request `category=performance&category=seo&category=accessibility&category=best-practices`; `strategy=mobile|desktop`. Without a key PSI is still attempted (keyless works at low volume); on any failure the source records the error rather than failing the scan.
- Jobs: new `JobType` `"seo_scan"` (per site). Weekly cadence: the nightly enqueue route enqueues `seo_scan` only when the latest `rankmath_audit` snapshot is older than 7 days (or absent), deduped.
- Storage: reuse `seo_snapshots (site_id, taken_at, source, payload)` from migration 0001. **One `taken_at` value per scan run** shared by all its source rows (use a single ISO timestamp computed once), so a run's rows group cleanly.
- Manual scan action: `requireUser()`-gated, confirm dialog via `ManageForm`, logs activity `site.seo_scan`, revalidates the SEO page and dashboard.
- Responsive + a11y as established (`overflow-x-auto` tables with `min-w`, `min-h-10` targets, flex-wrap, aria-live errors, no color-only meaning). Impeccable audit after the UI tasks.
- Commit after every task; PowerShell-safe commands.

## File Structure (new/changed)

```
src/lib/env.ts                                  # (no change — GOOGLE_PSI_API_KEY read via getOptionalEnv)
.env.example                                    # + GOOGLE_PSI_API_KEY
src/lib/adapters/psi.ts                         # fetchPsi + types
src/services/seo/types.ts                       # SeoSource, payload types, SourceResult, trend helpers
src/services/seo/repo.ts                        # SeoRepo + supabaseSeoRepo
src/services/seo/collect.ts                     # collectRankMath (per-source, capability-gated)
src/services/seo/scan.ts                        # seoScan orchestrator
src/services/jobs/types.ts                      # + "seo_scan"
src/services/jobs/handlers.ts                   # + seo_scan handler
src/app/api/cron/enqueue/route.ts               # + weekly seo_scan enqueue
src/app/(dashboard)/sites/[id]/tabs.tsx         # SEO → LIVE
src/app/(dashboard)/sites/[id]/seo-actions.ts   # runSeoScanAction
src/app/(dashboard)/sites/[id]/seo/page.tsx     # SEO tab
src/app/(dashboard)/sites/[id]/seo/sparkline.tsx# inline-SVG trend
src/app/(dashboard)/dashboard/page.tsx          # + SEO score chip
README.md
tests/{psi,seo-types,seo-collect,seo-scan}.test.ts
```

---

### Task 1: PageSpeed Insights adapter (TDD)

**Files:**
- Create: `src/lib/adapters/psi.ts`
- Modify: `.env.example`
- Test: `tests/psi.test.ts`

**Interfaces:**
- Consumes: `getOptionalEnv` (Phase 3).
- Produces:
```ts
export interface PsiResult {
  strategy: "mobile" | "desktop";
  performance: number | null;      // 0-100
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;            // largest-contentful-paint numericValue
  clsScore: number | null;         // cumulative-layout-shift numericValue
  fetchedUrl: string | null;
}
export function parsePsi(raw: unknown, strategy: "mobile" | "desktop"): PsiResult;
export async function fetchPsi(
  url: string, strategy: "mobile" | "desktop", fetchImpl?: typeof fetch,
): Promise<PsiResult>;   // uses GOOGLE_PSI_API_KEY when set; throws Error with status on non-200
```

- [ ] **Step 1: Write the failing tests**

`tests/psi.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { parsePsi, fetchPsi } from "@/lib/adapters/psi";

afterEach(() => { delete process.env.GOOGLE_PSI_API_KEY; });

const RAW = {
  id: "https://example.com/",
  lighthouseResult: {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    categories: {
      performance: { score: 0.72 },
      accessibility: { score: 0.95 },
      "best-practices": { score: 1 },
      seo: { score: 0.9 },
    },
    audits: {
      "largest-contentful-paint": { numericValue: 3120.4 },
      "cumulative-layout-shift": { numericValue: 0.042 },
    },
  },
};

describe("parsePsi", () => {
  it("maps 0-1 category scores to 0-100 and pulls core web vitals", () => {
    const r = parsePsi(RAW, "mobile");
    expect(r).toMatchObject({
      strategy: "mobile", performance: 72, accessibility: 95, bestPractices: 100, seo: 90,
      lcpMs: 3120, clsScore: 0.042, fetchedUrl: "https://example.com/",
    });
  });
  it("returns nulls for missing categories instead of throwing", () => {
    const r = parsePsi({ lighthouseResult: { categories: {}, audits: {} } }, "desktop");
    expect(r).toMatchObject({
      strategy: "desktop", performance: null, accessibility: null,
      bestPractices: null, seo: null, lcpMs: null, clsScore: null,
    });
  });
  it("tolerates a completely unexpected shape", () => {
    expect(parsePsi(null, "mobile").performance).toBeNull();
    expect(parsePsi("nope", "mobile").seo).toBeNull();
  });
});

describe("fetchPsi", () => {
  it("requests all four categories and the given strategy", async () => {
    const fetchImpl = (async (url: unknown) => {
      const u = String(url);
      expect(u).toContain("pagespeedonline/v5/runPagespeed");
      expect(u).toContain("strategy=mobile");
      expect(u).toContain("category=performance");
      expect(u).toContain("category=seo");
      expect(u).toContain("category=accessibility");
      expect(u).toContain("category=best-practices");
      expect(u).not.toContain("key=");
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as typeof fetch;
    const r = await fetchPsi("https://example.com", "mobile", fetchImpl);
    expect(r.performance).toBe(72);
  });

  it("appends the API key when configured", async () => {
    process.env.GOOGLE_PSI_API_KEY = "k123";
    const fetchImpl = (async (url: unknown) => {
      expect(String(url)).toContain("key=k123");
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as typeof fetch;
    await fetchPsi("https://example.com", "desktop", fetchImpl);
  });

  it("throws with the status and API message on failure", async () => {
    const body = JSON.stringify({ error: { message: "Quota exceeded" } });
    const fetchImpl = (async () => new Response(body, { status: 429 })) as typeof fetch;
    await expect(fetchPsi("https://example.com", "mobile", fetchImpl))
      .rejects.toThrow(/429.*Quota exceeded/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/psi.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/adapters/psi.ts`:
```ts
import { getOptionalEnv } from "@/lib/env";

export interface PsiResult {
  strategy: "mobile" | "desktop";
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;
  clsScore: number | null;
  fetchedUrl: string | null;
}

const API = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

function pct(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function num(v: unknown, digits = 0): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function parsePsi(raw: unknown, strategy: "mobile" | "desktop"): PsiResult {
  const lr = (raw && typeof raw === "object"
    ? (raw as { lighthouseResult?: Record<string, unknown> }).lighthouseResult
    : undefined) ?? {};
  const cats = (lr.categories ?? {}) as Record<string, { score?: unknown }>;
  const audits = (lr.audits ?? {}) as Record<string, { numericValue?: unknown }>;
  return {
    strategy,
    performance: pct(cats.performance?.score),
    accessibility: pct(cats.accessibility?.score),
    bestPractices: pct(cats["best-practices"]?.score),
    seo: pct(cats.seo?.score),
    lcpMs: num(audits["largest-contentful-paint"]?.numericValue),
    clsScore: num(audits["cumulative-layout-shift"]?.numericValue, 3),
    fetchedUrl: typeof lr.finalUrl === "string" ? lr.finalUrl : null,
  };
}

export async function fetchPsi(
  url: string, strategy: "mobile" | "desktop", fetchImpl: typeof fetch = fetch,
): Promise<PsiResult> {
  const params = new URLSearchParams();
  params.set("url", url);
  params.set("strategy", strategy);
  for (const c of ["performance", "accessibility", "best-practices", "seo"]) {
    params.append("category", c);
  }
  const key = getOptionalEnv("GOOGLE_PSI_API_KEY");
  if (key) params.set("key", key);

  const res = await fetchImpl(`${API}?${params.toString()}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ? `: ${body.error.message}` : "";
    } catch { /* body not JSON */ }
    throw new Error(`PageSpeed Insights failed: HTTP ${res.status}${detail}`);
  }
  return parsePsi(await res.json(), strategy);
}
```

Append to `.env.example`:
```
# optional: Google API key with PageSpeed Insights API enabled.
# Without it PSI still runs but is rate-limited much sooner.
GOOGLE_PSI_API_KEY=
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `npm test` → green (99 + 6 new); `npx tsc --noEmit` → 0 errors.

```powershell
git add src/lib/adapters/psi.ts .env.example tests/psi.test.ts; git commit -m "feat: PageSpeed Insights adapter"
```

---

### Task 2: SEO types, trend helpers, and repo (TDD on helpers)

**Files:**
- Create: `src/services/seo/types.ts`, `src/services/seo/repo.ts`
- Test: `tests/seo-types.test.ts`

**Interfaces:**
- Consumes: `PsiResult` (Task 1).
- Produces:
```ts
// types.ts
export type SeoSource = "rankmath_audit" | "rankmath_scores" | "links" | "keywords" | "ai_visibility" | "psi";
export const SEO_SOURCES: SeoSource[];
export type SourceStatus = "ok" | "skipped" | "error";
export interface SourceResult<T = unknown> { source: SeoSource; status: SourceStatus; reason?: string; data?: T }

export interface AuditFinding { test_id: string; category: string; status: string; title: string; description?: string; fix_text?: string; kb_link?: string }
export interface AuditPayload { url?: string; score: number | null; grade?: string; statuses?: { ok?: number; fail?: number; warning?: number; info?: number }; total_tests?: number; remote_api_status?: string; findings: AuditFinding[] }
export interface PageScore { post_id: number; title: string; keyword: string | null; score: number | null; grade: string; label?: string }
export interface LinkStats { total_internal: number; total_external: number; posts_no_internal: number; posts_no_external: number }
export interface KeywordRow { keyword: string; clicks: number; impressions: number; ctr: number; position: number }
export interface KeywordsPayload { connected: boolean; date_range?: string; keywords: KeywordRow[] }
export interface Brand { id: string; name: string; url?: string; score: number | null; rank: number | null; avg_sentiment: number | null; mentions: number | null; citations: number | null; analysis_status: string | null; last_analyzed: string | null }
export interface AiVisibilityPayload { brands: Brand[] }
export interface PsiPayload { mobile: PsiResult | null; desktop: PsiResult | null; url: string }

export function trendPoints(history: Array<{ taken_at: string; payload: unknown }>, pick: (p: unknown) => number | null): Array<{ at: string; value: number }>;
// oldest→newest, drops null values

// repo.ts
export interface SeoSnapshotRow { taken_at: string; source: SeoSource; payload: unknown }
export interface SeoRepo {
  insertSnapshots(siteId: string, takenAt: string, results: SourceResult[]): Promise<void>; // one row per result (payload = {status, reason?, data?})
  latestBySource(siteId: string): Promise<Partial<Record<SeoSource, SeoSnapshotRow>>>;
  history(siteId: string, source: SeoSource, limit?: number): Promise<SeoSnapshotRow[]>;   // ascending by taken_at
  latestAuditScore(siteId: string): Promise<number | null>;
  lastRunAt(siteId: string): Promise<string | null>;
}
export function supabaseSeoRepo(db: SupabaseClient): SeoRepo;
```
Stored payload shape per row: `{ status, reason?, data? }` — so the UI can distinguish "no data yet" from "source errored".

- [ ] **Step 1: Write the failing tests**

`tests/seo-types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { SEO_SOURCES, trendPoints, type SeoSource } from "@/services/seo/types";

describe("SEO_SOURCES", () => {
  it("lists every source exactly once", () => {
    const expected: SeoSource[] = [
      "rankmath_audit", "rankmath_scores", "links", "keywords", "ai_visibility", "psi",
    ];
    expect([...SEO_SOURCES].sort()).toEqual([...expected].sort());
    expect(new Set(SEO_SOURCES).size).toBe(SEO_SOURCES.length);
  });
});

describe("trendPoints", () => {
  const history = [
    { taken_at: "2026-08-01T00:00:00Z", payload: { status: "ok", data: { score: 61 } } },
    { taken_at: "2026-08-08T00:00:00Z", payload: { status: "error", reason: "boom" } },
    { taken_at: "2026-08-15T00:00:00Z", payload: { status: "ok", data: { score: 74 } } },
  ];
  const pick = (p: unknown) => {
    const d = (p as { data?: { score?: number | null } })?.data;
    return typeof d?.score === "number" ? d.score : null;
  };

  it("keeps only points with values, in order", () => {
    expect(trendPoints(history, pick)).toEqual([
      { at: "2026-08-01T00:00:00Z", value: 61 },
      { at: "2026-08-15T00:00:00Z", value: 74 },
    ]);
  });
  it("returns [] when nothing has a value", () => {
    expect(trendPoints([{ taken_at: "x", payload: { status: "error" } }], pick)).toEqual([]);
    expect(trendPoints([], pick)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/seo-types.test.ts` → FAIL.

- [ ] **Step 3: Implement types.ts**

`src/services/seo/types.ts`:
```ts
import type { PsiResult } from "@/lib/adapters/psi";

export type SeoSource =
  | "rankmath_audit" | "rankmath_scores" | "links" | "keywords" | "ai_visibility" | "psi";

export const SEO_SOURCES: SeoSource[] = [
  "rankmath_audit", "rankmath_scores", "links", "keywords", "ai_visibility", "psi",
];

export type SourceStatus = "ok" | "skipped" | "error";

export interface SourceResult<T = unknown> {
  source: SeoSource;
  status: SourceStatus;
  reason?: string;
  data?: T;
}

export interface AuditFinding {
  test_id: string; category: string; status: string; title: string;
  description?: string; fix_text?: string; kb_link?: string;
}
export interface AuditPayload {
  url?: string;
  score: number | null;
  grade?: string;
  statuses?: { ok?: number; fail?: number; warning?: number; info?: number };
  total_tests?: number;
  remote_api_status?: string;
  findings: AuditFinding[];
}
export interface PageScore {
  post_id: number; title: string; keyword: string | null;
  score: number | null; grade: string; label?: string;
}
export interface LinkStats {
  total_internal: number; total_external: number;
  posts_no_internal: number; posts_no_external: number;
}
export interface KeywordRow {
  keyword: string; clicks: number; impressions: number; ctr: number; position: number;
}
export interface KeywordsPayload { connected: boolean; date_range?: string; keywords: KeywordRow[] }
export interface Brand {
  id: string; name: string; url?: string;
  score: number | null; rank: number | null; avg_sentiment: number | null;
  mentions: number | null; citations: number | null;
  analysis_status: string | null; last_analyzed: string | null;
}
export interface AiVisibilityPayload { brands: Brand[] }
export interface PsiPayload { mobile: PsiResult | null; desktop: PsiResult | null; url: string }

export function trendPoints(
  history: Array<{ taken_at: string; payload: unknown }>,
  pick: (payload: unknown) => number | null,
): Array<{ at: string; value: number }> {
  const points: Array<{ at: string; value: number }> = [];
  for (const row of history) {
    const value = pick(row.payload);
    if (value !== null && Number.isFinite(value)) points.push({ at: row.taken_at, value });
  }
  return points;
}
```

- [ ] **Step 4: Implement repo.ts**

`src/services/seo/repo.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SeoSource, SourceResult } from "./types";

export interface SeoSnapshotRow { taken_at: string; source: SeoSource; payload: unknown }

export interface SeoRepo {
  insertSnapshots(siteId: string, takenAt: string, results: SourceResult[]): Promise<void>;
  latestBySource(siteId: string): Promise<Partial<Record<SeoSource, SeoSnapshotRow>>>;
  history(siteId: string, source: SeoSource, limit?: number): Promise<SeoSnapshotRow[]>;
  latestAuditScore(siteId: string): Promise<number | null>;
  lastRunAt(siteId: string): Promise<string | null>;
}

export function supabaseSeoRepo(db: SupabaseClient): SeoRepo {
  return {
    async insertSnapshots(siteId, takenAt, results) {
      if (results.length === 0) return;
      const rows = results.map((r) => ({
        site_id: siteId,
        taken_at: takenAt,
        source: r.source,
        payload: { status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.data !== undefined ? { data: r.data } : {}) },
      }));
      const { error } = await db.from("seo_snapshots").insert(rows);
      if (error) throw new Error(`seo_snapshots insert failed: ${error.message}`, { cause: error });
    },
    async latestBySource(siteId) {
      // Newest 60 rows covers ~10 runs of 6 sources; first row per source wins.
      const { data, error } = await db.from("seo_snapshots")
        .select("taken_at,source,payload").eq("site_id", siteId)
        .order("taken_at", { ascending: false }).limit(60);
      if (error) throw new Error(`latestBySource failed: ${error.message}`, { cause: error });
      const out: Partial<Record<SeoSource, SeoSnapshotRow>> = {};
      for (const row of data ?? []) {
        const source = row.source as SeoSource;
        if (!out[source]) out[source] = row as SeoSnapshotRow;
      }
      return out;
    },
    async history(siteId, source, limit = 20) {
      const { data, error } = await db.from("seo_snapshots")
        .select("taken_at,source,payload").eq("site_id", siteId).eq("source", source)
        .order("taken_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`seo history failed: ${error.message}`, { cause: error });
      return ((data ?? []) as SeoSnapshotRow[]).reverse();
    },
    async latestAuditScore(siteId) {
      const { data, error } = await db.from("seo_snapshots")
        .select("payload").eq("site_id", siteId).eq("source", "rankmath_audit")
        .order("taken_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`latestAuditScore failed: ${error.message}`, { cause: error });
      const score = (data?.payload as { data?: { score?: unknown } } | null)?.data?.score;
      return typeof score === "number" ? score : null;
    },
    async lastRunAt(siteId) {
      const { data, error } = await db.from("seo_snapshots")
        .select("taken_at").eq("site_id", siteId)
        .order("taken_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`seo lastRunAt failed: ${error.message}`, { cause: error });
      return data?.taken_at ?? null;
    },
  };
}
```

- [ ] **Step 5: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.

```powershell
git add src/services/seo tests/seo-types.test.ts; git commit -m "feat: SEO snapshot types, trend helper, and repo"
```

---

### Task 3: Rank Math collection (TDD)

**Files:**
- Create: `src/services/seo/collect.ts`
- Test: `tests/seo-collect.test.ts`

**Interfaces:**
- Consumes: `SiteMcpClient`, `unwrapAbility` is NOT needed (`executeAbility` already unwraps via `parseToolResult`? NO — `executeAbility` returns the ability envelope; use `unwrapAbility` from `@/lib/mcp/envelope`), `SourceResult` and payload types (Task 2).
- Produces:
```ts
export const RANKMATH_ABILITIES: Record<"rankmath_audit" | "rankmath_scores" | "links" | "keywords" | "ai_visibility", string>;
export async function collectRankMath(
  client: SiteMcpClient, abilities: string[],
): Promise<SourceResult[]>;   // 5 results, one per Rank Math source, order = RANKMATH_ABILITIES key order
// - ability not in `abilities` → { status: "skipped", reason: "Ability not available on this site" }
// - call throws → { status: "error", reason: message }
// - success → { status: "ok", data: normalized payload }
```
Ability names and arguments (verified live):
- `rank-math/audit-site-seo` `{}` → AuditPayload (findings default `[]`)
- `rank-math/get-seo-scores` `{ number_of_posts: 25 }` → array → `{ pages: PageScore[] }`
- `rank-math/get-link-report` `{}` → `{ stats, audit, upgrade }` → LinkStats subset
- `rank-math/get-top-keywords` `{ date_range: "last_30_days", limit: 25 }` → KeywordsPayload
- `rank-math/get-ai-visibility-overview` `{}` → `{ brands }`

- [ ] **Step 1: Write the failing tests**

`tests/seo-collect.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { collectRankMath, RANKMATH_ABILITIES } from "@/services/seo/collect";
import { MockMcpClient } from "@/lib/mcp/mock";
import type { AuditPayload, KeywordsPayload, PageScore } from "@/services/seo/types";

const ALL = Object.values(RANKMATH_ABILITIES);

// Shapes copied from live probes of a production site (2026-08-28).
const RESPONSES: Record<string, unknown> = {
  "rank-math/audit-site-seo": {
    url: "https://site.test", score: 68, grade: "average",
    statuses: { ok: 20, fail: 3, warning: 5, info: 2 }, total_tests: 30,
    remote_api_status: "ok",
    findings: [
      { test_id: "title_length", category: "basic", status: "fail", title: "Title too long",
        description: "d", fix_text: "Shorten it", kb_link: "https://rankmath.com/kb/x" },
    ],
  },
  "rank-math/get-seo-scores": [
    { post_id: 3843, title: "How to Buy Property", keyword: "buy property", score: 57, grade: "ok", label: "OK", last_updated: 1787807148 },
    { post_id: 3841, title: "Permits", keyword: "permits", score: 15, grade: "bad", label: "Needs improvement", last_updated: 1787806307 },
  ],
  "rank-math/get-link-report": {
    stats: { total_internal: 120, total_external: 45, posts_no_internal: 3, posts_no_external: 9 },
    audit: null, upgrade: { message: "Upgrade", url: "https://rankmath.com/pricing" },
  },
  "rank-math/get-top-keywords": {
    keywords: [{ keyword: "el nido", clicks: 120, impressions: 4000, ctr: 3, position: 8.4 }],
    date_range: "last_30_days", connected: true,
  },
  "rank-math/get-ai-visibility-overview": { summary: [], brands: [] },
};

function client(overrides: Record<string, unknown> = {}, failing: string[] = []) {
  const table = { ...RESPONSES, ...overrides };
  return new MockMcpClient({
    handler: (name, args) => {
      expect(name).toBe("mcp-adapter-execute-ability-not-used"); // placeholder, replaced below
      return null;
    },
  });
}

describe("collectRankMath", () => {
  function build(overrides: Record<string, unknown> = {}, failing: string[] = []) {
    const table = { ...RESPONSES, ...overrides };
    return new MockMcpClient({
      handler: (abilityName) => {
        if (failing.includes(abilityName)) throw new Error(`boom: ${abilityName}`);
        if (!(abilityName in table)) throw new Error(`unexpected ability ${abilityName}`);
        // Abilities come back wrapped in the adapter envelope.
        return { success: true, data: table[abilityName] };
      },
    });
  }

  it("collects all five sources with normalized payloads", async () => {
    const results = await collectRankMath(build(), ALL);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === "ok")).toBe(true);

    const audit = results.find((r) => r.source === "rankmath_audit")!.data as AuditPayload;
    expect(audit.score).toBe(68);
    expect(audit.findings[0].test_id).toBe("title_length");

    const scores = results.find((r) => r.source === "rankmath_scores")!.data as { pages: PageScore[] };
    expect(scores.pages).toHaveLength(2);
    expect(scores.pages[1]).toMatchObject({ post_id: 3841, grade: "bad" });

    const links = results.find((r) => r.source === "links")!.data as { stats: { total_internal: number } };
    expect(links.stats.total_internal).toBe(120);

    const kw = results.find((r) => r.source === "keywords")!.data as KeywordsPayload;
    expect(kw.connected).toBe(true);
    expect(kw.keywords[0].keyword).toBe("el nido");

    const aeo = results.find((r) => r.source === "ai_visibility")!.data as { brands: unknown[] };
    expect(aeo.brands).toEqual([]);
  });

  it("skips sources whose ability the site lacks", async () => {
    const results = await collectRankMath(build(), ["rank-math/audit-site-seo"]);
    const audit = results.find((r) => r.source === "rankmath_audit")!;
    const kw = results.find((r) => r.source === "keywords")!;
    expect(audit.status).toBe("ok");
    expect(kw.status).toBe("skipped");
    expect(kw.reason).toMatch(/not available/i);
  });

  it("records per-source errors without failing the others", async () => {
    const results = await collectRankMath(build({}, ["rank-math/get-link-report"]), ALL);
    const links = results.find((r) => r.source === "links")!;
    expect(links.status).toBe("error");
    expect(links.reason).toMatch(/boom/);
    expect(results.filter((r) => r.status === "ok")).toHaveLength(4);
  });

  it("tolerates unexpected payload shapes", async () => {
    const results = await collectRankMath(
      build({ "rank-math/get-seo-scores": { not: "an array" }, "rank-math/audit-site-seo": null }), ALL,
    );
    const scores = results.find((r) => r.source === "rankmath_scores")!.data as { pages: PageScore[] };
    expect(scores.pages).toEqual([]);
    const audit = results.find((r) => r.source === "rankmath_audit")!.data as AuditPayload;
    expect(audit.score).toBeNull();
    expect(audit.findings).toEqual([]);
  });
});
```
(Delete the unused `client` helper above when implementing — the `build` helper inside the describe is the one used.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/seo-collect.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/services/seo/collect.ts`:
```ts
import type { SiteMcpClient } from "@/lib/mcp/client";
import { unwrapAbility } from "@/lib/mcp/envelope";
import type {
  AiVisibilityPayload, AuditFinding, AuditPayload, Brand, KeywordRow,
  KeywordsPayload, LinkStats, PageScore, SeoSource, SourceResult,
} from "./types";

const SEO_TIMEOUT_MS = 120_000;

export const RANKMATH_ABILITIES = {
  rankmath_audit: "rank-math/audit-site-seo",
  rankmath_scores: "rank-math/get-seo-scores",
  links: "rank-math/get-link-report",
  keywords: "rank-math/get-top-keywords",
  ai_visibility: "rank-math/get-ai-visibility-overview",
} as const;

const ARGS: Record<string, Record<string, unknown>> = {
  "rank-math/audit-site-seo": {},
  "rank-math/get-seo-scores": { number_of_posts: 25 },
  "rank-math/get-link-report": {},
  "rank-math/get-top-keywords": { date_range: "last_30_days", limit: 25 },
  "rank-math/get-ai-visibility-overview": {},
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function normalizeAudit(raw: unknown): AuditPayload {
  const r = obj(raw);
  const findings = Array.isArray(r.findings) ? r.findings : [];
  return {
    url: typeof r.url === "string" ? r.url : undefined,
    score: numOrNull(r.score),
    grade: typeof r.grade === "string" ? r.grade : undefined,
    statuses: obj(r.statuses) as AuditPayload["statuses"],
    total_tests: numOrNull(r.total_tests) ?? undefined,
    remote_api_status: typeof r.remote_api_status === "string" ? r.remote_api_status : undefined,
    findings: findings.map((f): AuditFinding => {
      const x = obj(f);
      return {
        test_id: str(x.test_id, "unknown"),
        category: str(x.category, "basic"),
        status: str(x.status, "info"),
        title: str(x.title, str(x.test_id, "Finding")),
        description: typeof x.description === "string" ? x.description : undefined,
        fix_text: typeof x.fix_text === "string" ? x.fix_text : undefined,
        kb_link: typeof x.kb_link === "string" ? x.kb_link : undefined,
      };
    }),
  };
}

function normalizeScores(raw: unknown): { pages: PageScore[] } {
  const list = Array.isArray(raw) ? raw : [];
  return {
    pages: list.map((p): PageScore => {
      const x = obj(p);
      return {
        post_id: numOrNull(x.post_id) ?? 0,
        title: str(x.title, "(untitled)"),
        keyword: typeof x.keyword === "string" ? x.keyword : null,
        score: numOrNull(x.score),
        grade: str(x.grade, "na"),
        label: typeof x.label === "string" ? x.label : undefined,
      };
    }),
  };
}

function normalizeLinks(raw: unknown): { stats: LinkStats; upgrade: string | null } {
  const r = obj(raw);
  const s = obj(r.stats);
  return {
    stats: {
      total_internal: numOrNull(s.total_internal) ?? 0,
      total_external: numOrNull(s.total_external) ?? 0,
      posts_no_internal: numOrNull(s.posts_no_internal) ?? 0,
      posts_no_external: numOrNull(s.posts_no_external) ?? 0,
    },
    upgrade: typeof obj(r.upgrade).message === "string" ? String(obj(r.upgrade).message) : null,
  };
}

function normalizeKeywords(raw: unknown): KeywordsPayload {
  const r = obj(raw);
  const list = Array.isArray(r.keywords) ? r.keywords : [];
  return {
    connected: r.connected === true,
    date_range: typeof r.date_range === "string" ? r.date_range : undefined,
    keywords: list.map((k): KeywordRow => {
      const x = obj(k);
      return {
        keyword: str(x.keyword, "(unknown)"),
        clicks: numOrNull(x.clicks) ?? 0,
        impressions: numOrNull(x.impressions) ?? 0,
        ctr: numOrNull(x.ctr) ?? 0,
        position: numOrNull(x.position) ?? 0,
      };
    }),
  };
}

function normalizeAiVisibility(raw: unknown): AiVisibilityPayload {
  const r = obj(raw);
  const list = Array.isArray(r.brands) ? r.brands : [];
  return {
    brands: list.map((b): Brand => {
      const x = obj(b);
      return {
        id: str(x.id, ""),
        name: str(x.name, "(unnamed brand)"),
        url: typeof x.url === "string" ? x.url : undefined,
        score: numOrNull(x.score),
        rank: numOrNull(x.rank),
        avg_sentiment: numOrNull(x.avg_sentiment),
        mentions: numOrNull(x.mentions),
        citations: numOrNull(x.citations),
        analysis_status: typeof x.analysis_status === "string" ? x.analysis_status : null,
        last_analyzed: typeof x.last_analyzed === "string" ? x.last_analyzed : null,
      };
    }),
  };
}

const NORMALIZERS: Record<string, (raw: unknown) => unknown> = {
  "rank-math/audit-site-seo": normalizeAudit,
  "rank-math/get-seo-scores": normalizeScores,
  "rank-math/get-link-report": normalizeLinks,
  "rank-math/get-top-keywords": normalizeKeywords,
  "rank-math/get-ai-visibility-overview": normalizeAiVisibility,
};

export async function collectRankMath(
  client: SiteMcpClient, abilities: string[],
): Promise<SourceResult[]> {
  const available = new Set(abilities);
  const results: SourceResult[] = [];
  for (const [source, ability] of Object.entries(RANKMATH_ABILITIES) as Array<[SeoSource, string]>) {
    if (!available.has(ability)) {
      results.push({
        source, status: "skipped",
        reason: `Ability not available on this site (${ability})`,
      });
      continue;
    }
    try {
      const raw = await client.executeAbility(ability, ARGS[ability], { timeoutMs: SEO_TIMEOUT_MS });
      results.push({ source, status: "ok", data: NORMALIZERS[ability](unwrapAbility(raw)) });
    } catch (e) {
      results.push({ source, status: "error", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.

```powershell
git add src/services/seo/collect.ts tests/seo-collect.test.ts; git commit -m "feat: capability-gated Rank Math collection with per-source error isolation"
```

---

### Task 4: SEO scan orchestrator + job wiring (TDD)

**Files:**
- Create: `src/services/seo/scan.ts`
- Modify: `src/services/jobs/types.ts`, `src/services/jobs/handlers.ts`, `src/app/api/cron/enqueue/route.ts`
- Test: `tests/seo-scan.test.ts`

**Interfaces:**
- Consumes: `collectRankMath` (T3), `fetchPsi` (T1), `SeoRepo` (T2), `SitesRepo`, `McpFactory`, `decryptSecret`.
- Produces:
```ts
// jobs/types.ts
export type JobType = "snapshot_refresh" | "security_scan" | "vuln_feed_refresh" | "plugin_install" | "seo_scan";

// seo/scan.ts
export interface SeoScanDeps { sites: SitesRepo; seo: SeoRepo; mcp: McpFactory; fetchImpl?: typeof fetch }
export async function seoScan(deps: SeoScanDeps, siteId: string): Promise<{ takenAt: string; results: SourceResult[] }>;
// flow: getSite (throw if missing) → open client (closed in finally) → collectRankMath(client, site.capabilities.abilities)
//       → PSI mobile+desktop (one SourceResult "psi"; per-strategy failures recorded inside data, both failing → status error)
//       → seo.insertSnapshots(siteId, takenAt, results)
```
Enqueue rule (weekly): in `/api/cron/enqueue`, for each non-disabled site, call `seo.lastRunAt(site.id)`; enqueue deduped `seo_scan` when it is null or older than 7 days. Response gains `seo` count.

- [ ] **Step 1: Write the failing tests**

`tests/seo-scan.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { seoScan, type SeoScanDeps } from "@/services/seo/scan";
import type { SeoRepo, SeoSnapshotRow } from "@/services/seo/repo";
import type { SourceResult } from "@/services/seo/types";
import type { SitesRepo } from "@/services/sites/repo";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

const ABILITIES = [
  "rank-math/audit-site-seo", "rank-math/get-seo-scores", "rank-math/get-link-report",
  "rank-math/get-top-keywords", "rank-math/get-ai-visibility-overview",
];

const RM_RESPONSES: Record<string, unknown> = {
  "rank-math/audit-site-seo": { score: 68, grade: "average", findings: [] },
  "rank-math/get-seo-scores": [],
  "rank-math/get-link-report": { stats: { total_internal: 1, total_external: 2, posts_no_internal: 0, posts_no_external: 0 } },
  "rank-math/get-top-keywords": { keywords: [], connected: false },
  "rank-math/get-ai-visibility-overview": { brands: [] },
};

const PSI_RAW = {
  lighthouseResult: {
    finalUrl: "https://site.test/",
    categories: { performance: { score: 0.5 }, seo: { score: 0.9 }, accessibility: { score: 1 }, "best-practices": { score: 1 } },
    audits: { "largest-contentful-paint": { numericValue: 2500 }, "cumulative-layout-shift": { numericValue: 0.01 } },
  },
};

function fakes(opts: { abilities?: string[]; psiFails?: boolean } = {}) {
  const inserted: Array<{ takenAt: string; results: SourceResult[] }> = [];
  let creds = "";
  const client = new MockMcpClient({
    handler: (ability) => ({ success: true, data: RM_RESPONSES[ability] ?? null }),
  });
  const sites = {
    async getSite(id: string) {
      return id === "site-1"
        ? { id, name: "S", url: "https://site.test", mcp_endpoint: "https://site.test/wp-json/mcp/novamira",
            wp_username: "admin", status: "connected", client_label: null,
            capabilities: { abilities: opts.abilities ?? ABILITIES }, created_at: "", updated_at: "" }
        : null;
    },
    async getSiteCredentials() {
      return { mcp_endpoint: "https://site.test/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: creds };
    },
  } as unknown as SitesRepo;
  const seo: SeoRepo = {
    async insertSnapshots(_s, takenAt, results) { inserted.push({ takenAt, results }); },
    async latestBySource() { return {}; },
    async history() { return [] as SeoSnapshotRow[]; },
    async latestAuditScore() { return null; },
    async lastRunAt() { return null; },
  };
  const fetchImpl = (async () => opts.psiFails
    ? new Response("{}", { status: 500 })
    : new Response(JSON.stringify(PSI_RAW), { status: 200 })) as typeof fetch;
  const deps: SeoScanDeps = { sites, seo, mcp: async () => client, fetchImpl };
  return { deps, inserted, client, setCreds: (v: string) => { creds = v; } };
}

describe("seoScan", () => {
  it("stores six sources under one timestamp and closes the client", async () => {
    const f = fakes();
    f.setCreds(await encryptSecret("pass"));
    const res = await seoScan(f.deps, "site-1");
    expect(res.results).toHaveLength(6);
    expect(new Set(res.results.map((r) => r.source)).size).toBe(6);
    expect(f.client.closed).toBe(true);
    expect(f.inserted).toHaveLength(1);
    expect(f.inserted[0].takenAt).toBe(res.takenAt);
    expect(f.inserted[0].results.every((r) => r.status === "ok")).toBe(true);
    const psi = res.results.find((r) => r.source === "psi")!.data as { mobile: { performance: number } | null };
    expect(psi.mobile?.performance).toBe(50);
  });

  it("records a psi error without failing the scan", async () => {
    const f = fakes({ psiFails: true });
    f.setCreds(await encryptSecret("pass"));
    const res = await seoScan(f.deps, "site-1");
    const psi = res.results.find((r) => r.source === "psi")!;
    expect(psi.status).toBe("error");
    expect(res.results.filter((r) => r.status === "ok")).toHaveLength(5);
  });

  it("marks Rank Math sources skipped when the site lacks the abilities", async () => {
    const f = fakes({ abilities: [] });
    f.setCreds(await encryptSecret("pass"));
    const res = await seoScan(f.deps, "site-1");
    expect(res.results.filter((r) => r.status === "skipped")).toHaveLength(5);
    expect(res.results.find((r) => r.source === "psi")!.status).toBe("ok");
  });

  it("throws for an unknown site", async () => {
    const f = fakes();
    await expect(seoScan(f.deps, "nope")).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/seo-scan.test.ts` → FAIL.

- [ ] **Step 3: Implement scan.ts**

`src/services/seo/scan.ts`:
```ts
import { decryptSecret } from "@/lib/crypto/secrets";
import { fetchPsi, type PsiResult } from "@/lib/adapters/psi";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import { collectRankMath } from "./collect";
import type { SeoRepo } from "./repo";
import type { PsiPayload, SourceResult } from "./types";

export interface SeoScanDeps {
  sites: SitesRepo;
  seo: SeoRepo;
  mcp: McpFactory;
  fetchImpl?: typeof fetch;
}

async function collectPsi(url: string, fetchImpl?: typeof fetch): Promise<SourceResult<PsiPayload>> {
  const run = async (strategy: "mobile" | "desktop") => {
    try {
      return { value: await fetchPsi(url, strategy, fetchImpl ?? fetch), error: null as string | null };
    } catch (e) {
      return { value: null as PsiResult | null, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const [mobile, desktop] = await Promise.all([run("mobile"), run("desktop")]);
  if (!mobile.value && !desktop.value) {
    return { source: "psi", status: "error", reason: mobile.error ?? desktop.error ?? "PageSpeed Insights failed" };
  }
  return {
    source: "psi",
    status: "ok",
    ...(mobile.error || desktop.error
      ? { reason: [mobile.error, desktop.error].filter(Boolean).join(" | ") }
      : {}),
    data: { mobile: mobile.value, desktop: desktop.value, url },
  };
}

export async function seoScan(
  deps: SeoScanDeps, siteId: string,
): Promise<{ takenAt: string; results: SourceResult[] }> {
  const site = await deps.sites.getSite(siteId);
  if (!site) throw new Error(`Site not found: ${siteId}`);

  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) throw new Error(`Credentials missing for site: ${siteId}`);

  const client = await deps.mcp({
    endpoint: creds.mcp_endpoint,
    username: creds.wp_username,
    appPassword: await decryptSecret(creds.app_password_encrypted),
  });
  let results: SourceResult[];
  try {
    results = await collectRankMath(client, site.capabilities?.abilities ?? []);
  } finally {
    await client.close();
  }

  results.push(await collectPsi(site.url, deps.fetchImpl));

  const takenAt = new Date().toISOString();
  await deps.seo.insertSnapshots(siteId, takenAt, results);
  return { takenAt, results };
}
```

- [ ] **Step 4: Wire the job type, handler, and weekly enqueue**

`src/services/jobs/types.ts` — extend the union:
```ts
export type JobType =
  | "snapshot_refresh" | "security_scan" | "vuln_feed_refresh" | "plugin_install" | "seo_scan";
```

`src/services/jobs/handlers.ts` — add imports and one handler:
```ts
import { seoScan } from "@/services/seo/scan";
import { supabaseSeoRepo } from "@/services/seo/repo";
// inside buildJobHandlers, alongside the existing repos:
const seo = supabaseSeoRepo(db);
// and in the returned object:
    seo_scan: async ({ job }) => {
      if (!job.site_id) throw new Error("seo_scan requires site_id");
      await seoScan({ sites, seo, mcp: createSiteMcpClient }, job.site_id);
    },
```

`src/app/api/cron/enqueue/route.ts` — add the weekly rule. Add imports:
```ts
import { supabaseSeoRepo } from "@/services/seo/repo";
```
After the existing `security_scan` loop and before the final `return`:
```ts
  const seo = supabaseSeoRepo(db);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let seoScans = 0;
  for (const site of sites) {
    if (site.status === "disabled") continue;
    const last = await seo.lastRunAt(site.id);
    if (last && new Date(last).getTime() > weekAgo) continue;
    const res = await enqueueJob(jobs, "seo_scan", site.id, {}, { dedupe: true });
    if (res) seoScans++;
  }
```
and change the response line to:
```ts
  return NextResponse.json({ ok: true, sites: sites.length, enqueued, scans, seo: seoScans, feed: Boolean(feedJob) });
```

- [ ] **Step 5: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors; `npm run build` → success.

```powershell
git add src/services/seo/scan.ts src/services/jobs src/app/api/cron/enqueue/route.ts tests/seo-scan.test.ts; git commit -m "feat: SEO scan orchestrator with weekly job scheduling"
```

---

### Task 5: SEO tab UI + scan action + tabs/dashboard wiring

**Files:**
- Create: `src/app/(dashboard)/sites/[id]/seo-actions.ts`, `src/app/(dashboard)/sites/[id]/seo/page.tsx`, `src/app/(dashboard)/sites/[id]/seo/sparkline.tsx`
- Modify: `src/app/(dashboard)/sites/[id]/tabs.tsx`, `src/app/(dashboard)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `seoScan` (T4), `supabaseSeoRepo` + `trendPoints` (T2), `ManageForm`/`ManageFormAction`, `requireUser`, repos.
- Produces: route `/sites/[id]/seo`; `runSeoScanAction(siteId)`; `Sparkline({ points, label })`.

- [ ] **Step 1: Implement the scan action**

`src/app/(dashboard)/sites/[id]/seo-actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { seoScan } from "@/services/seo/scan";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

export async function runSeoScanAction(siteId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const db = createServiceSupabase();
  try {
    await seoScan(
      { sites: supabaseSitesRepo(db), seo: supabaseSeoRepo(db), mcp: createSiteMcpClient },
      siteId,
    );
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.seo_scan", detail: { manual: true },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "SEO scan failed" };
  }
  revalidatePath(`/sites/${siteId}/seo`);
  revalidatePath("/dashboard");
  return { ok: true };
}
```

- [ ] **Step 2: Implement the sparkline**

`src/app/(dashboard)/sites/[id]/seo/sparkline.tsx`:
```tsx
export function Sparkline({
  points, label,
}: { points: Array<{ at: string; value: number }>; label: string }) {
  if (points.length < 2) {
    return <p className="text-xs text-slate-400">Not enough history yet for a trend.</p>;
  }
  const w = 240;
  const h = 48;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * (w - 4) + 2;
    const y = h - 4 - ((p.value - min) / span) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = points[0];
  const last = points[points.length - 1];
  const delta = last.value - first.value;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full max-w-60" role="img"
        aria-label={`${label}: ${first.value} on ${new Date(first.at).toLocaleDateString()} to ${last.value} on ${new Date(last.at).toLocaleDateString()}`}>
        <polyline points={coords.join(" ")} fill="none" stroke="currentColor" strokeWidth="2"
          className="text-slate-700" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <p className="text-xs text-slate-500">
        {points.length} runs · {delta === 0 ? "no change" : `${delta > 0 ? "+" : ""}${delta} since ${new Date(first.at).toLocaleDateString()}`}
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Implement the SEO page**

`src/app/(dashboard)/sites/[id]/seo/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { trendPoints } from "@/services/seo/types";
import type {
  AiVisibilityPayload, AuditPayload, KeywordsPayload, LinkStats, PageScore, PsiPayload,
} from "@/services/seo/types";
import { SiteTabs } from "../tabs";
import { ManageForm, type ManageFormAction } from "../action-form";
import { runSeoScanAction } from "../seo-actions";
import { Sparkline } from "./sparkline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Row = { taken_at: string; payload: unknown } | undefined;
const dataOf = <T,>(row: Row): T | null => {
  const p = row?.payload as { status?: string; data?: T } | undefined;
  return p?.status === "ok" && p.data !== undefined ? p.data : null;
};
const noteOf = (row: Row): string | null => {
  const p = row?.payload as { status?: string; reason?: string } | undefined;
  if (!p) return null;
  if (p.status === "ok") return p.reason ?? null;
  return p.reason ?? (p.status === "skipped" ? "Not available on this site" : "Failed");
};

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-sm text-slate-400">—</span>;
  const cls = score >= 80 ? "bg-green-100 text-green-800"
    : score >= 50 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{score}</span>;
}

export default async function SeoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();

  const seo = supabaseSeoRepo(db);
  const [latest, auditHistory, lastRun] = await Promise.all([
    seo.latestBySource(id), seo.history(id, "rankmath_audit", 20), seo.lastRunAt(id),
  ]);

  const audit = dataOf<AuditPayload>(latest.rankmath_audit);
  const pages = dataOf<{ pages: PageScore[] }>(latest.rankmath_scores)?.pages ?? [];
  const links = dataOf<{ stats: LinkStats; upgrade: string | null }>(latest.links);
  const keywords = dataOf<KeywordsPayload>(latest.keywords);
  const aeo = dataOf<AiVisibilityPayload>(latest.ai_visibility);
  const psi = dataOf<PsiPayload>(latest.psi);

  const trend = trendPoints(auditHistory, (p) => {
    const d = (p as { data?: { score?: number | null } })?.data;
    return typeof d?.score === "number" ? d.score : null;
  });

  const scan = runSeoScanAction.bind(null, id) as unknown as ManageFormAction;
  const failing = (audit?.findings ?? []).filter((f) => f.status === "fail" || f.status === "warning");

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">SEO &amp; AEO</p>
      <SiteTabs siteId={id} active="seo" />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-3xl font-bold">{audit?.score ?? "—"}<span className="text-base font-normal text-slate-400">/100</span></p>
            <p className="text-xs text-slate-500">
              Rank Math site audit{audit?.grade ? ` · ${audit.grade}` : ""}
              {lastRun ? ` · ${new Date(lastRun).toLocaleString()}` : " · never run"}
            </p>
          </div>
          <Sparkline points={trend} label="SEO audit score" />
        </div>
        <ManageForm action={scan} label="Run SEO scan" pendingLabel="Scanning… (up to a few minutes)"
          confirmMessage={`Run a full SEO scan on ${site.name} now?`}
          buttonClassName="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" />
      </div>

      {psi && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Performance (mobile)", value: psi.mobile?.performance ?? null },
            { label: "SEO (mobile)", value: psi.mobile?.seo ?? null },
            { label: "Accessibility", value: psi.mobile?.accessibility ?? null },
            { label: "Performance (desktop)", value: psi.desktop?.performance ?? null },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border bg-white p-3 text-center shadow-sm">
              <p className="text-lg font-semibold">{s.value ?? "—"}</p>
              <p className="text-xs text-slate-500">{s.label}</p>
            </div>
          ))}
        </div>
      )}
      {noteOf(latest.psi) && <p className="mb-4 text-xs text-amber-700">PageSpeed: {noteOf(latest.psi)}</p>}

      <section className="mb-6 rounded-lg border bg-white shadow-sm">
        <h2 className="border-b px-4 py-3 font-medium">
          Audit findings {failing.length > 0 && <span className="text-amber-700">({failing.length} need attention)</span>}
        </h2>
        {!audit ? (
          <p className="px-4 py-6 text-sm text-slate-500">{noteOf(latest.rankmath_audit) ?? "Run a scan to see audit findings."}</p>
        ) : failing.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">No failing tests. {audit.total_tests ?? 0} checks run.</p>
        ) : (
          <ul className="divide-y">
            {failing.slice(0, 20).map((f) => (
              <li key={f.test_id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{f.title}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${
                    f.status === "fail" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>
                    {f.status}
                  </span>
                </div>
                {f.fix_text && <p className="mt-1 text-xs text-slate-600">{f.fix_text}</p>}
                {f.kb_link && (
                  <a href={f.kb_link} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs underline">
                    How to fix
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-lg border bg-white shadow-sm">
          <h2 className="border-b px-4 py-3 font-medium">Pages needing attention</h2>
          {pages.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">{noteOf(latest.rankmath_scores) ?? "No page scores yet."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2">Page</th>
                    <th className="px-4 py-2">Focus keyword</th>
                    <th className="px-4 py-2">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {[...pages].sort((a, b) => (a.score ?? 101) - (b.score ?? 101)).slice(0, 10).map((p) => (
                    <tr key={p.post_id} className="border-b last:border-0">
                      <td className="max-w-64 truncate px-4 py-2" title={p.title}>{p.title}</td>
                      <td className="max-w-40 truncate px-4 py-2 text-slate-500">{p.keyword ?? "— none —"}</td>
                      <td className="px-4 py-2"><ScoreBadge score={p.score} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-lg border bg-white shadow-sm">
          <h2 className="border-b px-4 py-3 font-medium">Search Console keywords</h2>
          {!keywords ? (
            <p className="px-4 py-6 text-sm text-slate-500">{noteOf(latest.keywords) ?? "No keyword data yet."}</p>
          ) : !keywords.connected ? (
            <p className="px-4 py-6 text-sm text-slate-500">
              Google Search Console is not connected in Rank Math on this site.
            </p>
          ) : keywords.keywords.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">No keyword impressions in the last 30 days.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2">Keyword</th>
                    <th className="px-4 py-2">Clicks</th>
                    <th className="px-4 py-2">Impr.</th>
                    <th className="px-4 py-2">Pos.</th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.keywords.slice(0, 10).map((k) => (
                    <tr key={k.keyword} className="border-b last:border-0">
                      <td className="max-w-56 truncate px-4 py-2" title={k.keyword}>{k.keyword}</td>
                      <td className="px-4 py-2">{k.clicks}</td>
                      <td className="px-4 py-2">{k.impressions}</td>
                      <td className="px-4 py-2">{k.position.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">AI Visibility (AEO)</h2>
          {!aeo ? (
            <p className="text-sm text-slate-500">{noteOf(latest.ai_visibility) ?? "No AEO data yet."}</p>
          ) : aeo.brands.length === 0 ? (
            <p className="text-sm text-slate-500">
              No brands tracked yet. Add a brand in Rank Math → AI Visibility to start measuring how AI assistants cite this site.
            </p>
          ) : (
            <ul className="space-y-3 text-sm">
              {aeo.brands.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{b.name}</p>
                    <p className="text-xs text-slate-500">
                      {b.mentions ?? 0} mentions · {b.citations ?? 0} citations
                      {b.analysis_status ? ` · ${b.analysis_status}` : ""}
                    </p>
                  </div>
                  <ScoreBadge score={b.score} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Links</h2>
          {!links ? (
            <p className="text-sm text-slate-500">{noteOf(latest.links) ?? "No link report yet."}</p>
          ) : (
            <>
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-slate-500">Internal links</dt><dd>{links.stats.total_internal}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">External links</dt><dd>{links.stats.total_external}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Posts with no internal links</dt><dd>{links.stats.posts_no_internal}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Posts with no external links</dt><dd>{links.stats.posts_no_external}</dd></div>
              </dl>
              {links.upgrade && <p className="mt-3 text-xs text-slate-500">{links.upgrade}</p>}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Tabs + dashboard chip**

In `src/app/(dashboard)/sites/[id]/tabs.tsx`, move SEO into `LIVE`:
```ts
const LIVE = [
  { key: "overview", label: "Overview", href: (id: string) => `/sites/${id}` },
  { key: "plugins", label: "Plugins", href: (id: string) => `/sites/${id}/plugins` },
  { key: "themes", label: "Themes", href: (id: string) => `/sites/${id}/themes` },
  { key: "security", label: "Security", href: (id: string) => `/sites/${id}/security` },
  { key: "seo", label: "SEO", href: (id: string) => `/sites/${id}/seo` },
] as const;
const COMING = ["GeoGrid", "Reports"];
```

In `src/app/(dashboard)/dashboard/page.tsx`:
- Add import: `import { supabaseSeoRepo } from "@/services/seo/repo";`
- Alongside the existing grade gathering, add:
```ts
const seoRepo = supabaseSeoRepo(db);
const seoScores = new Map<string, number>();
await Promise.all(sites.map(async (s) => {
  const score = await seoRepo.latestAuditScore(s.id);
  if (score !== null) seoScores.set(s.id, score);
}));
```
- In the card footer paragraph, after the security chip, add:
```tsx
{seoScores.has(s.id) && (
  <span className={`rounded-full px-2 py-0.5 ${
    seoScores.get(s.id)! >= 80 ? "bg-green-100 text-green-800"
      : seoScores.get(s.id)! >= 50 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"
  }`}>
    SEO {seoScores.get(s.id)}
  </span>
)}
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — all green.

```powershell
git add "src/app/(dashboard)"; git commit -m "feat: SEO tab with audit findings, page scores, keywords, AEO, and trends"
```

---

### Task 6: README + docs

**Files:**
- Modify: `README.md`, `docs/ops/scheduling.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: README**

In `README.md`, extend the "Background jobs" list with:
```markdown
- Weekly per site: `seo_scan` (Rank Math audit, page scores, links, Search Console
  keywords, AI Visibility) plus PageSpeed Insights for mobile and desktop. Set
  `GOOGLE_PSI_API_KEY` (optional) to raise PageSpeed rate limits.
```
And add a section after "Marketplace":
```markdown
## SEO & AEO

The SEO tab shows the Rank Math site-audit score with a trend sparkline, failing
audit findings with fix links, the lowest-scoring pages, Search Console keywords,
PageSpeed Insights scores, and the AI Visibility (AEO) brand panel. Sites without
Rank Math still get PageSpeed data — each source is collected independently, and a
source that is unavailable or fails is labelled on the page rather than failing
the scan.
```

- [ ] **Step 2: Scheduling doc note**

In `docs/ops/scheduling.md`, under the nightly enqueue explanation, append:
```markdown
The nightly enqueue also queues one `seo_scan` per site whose last SEO run is
older than 7 days, so SEO data refreshes weekly without a separate schedule.
```

- [ ] **Step 3: Commit**

```powershell
git add README.md docs/ops/scheduling.md; git commit -m "docs: SEO/AEO phase documentation"
```

---

## Self-Review Notes

- **Spec §6.3 coverage:** Rank Math audit + scores + links + keywords + AI Visibility (T3), PSI mobile/desktop (T1), weekly job + on-demand scan (T4, T5), trends over time (T2 helper + T5 sparkline), fix hints surfaced with `kb_link` (T5), dashboard SEO chip (T5). The spec's one-click `fix-site-seo` is deliberately **out of scope** — Rank Math's auto-fixes mutate site config and deserve their own confirm-per-fix design; noted for a later phase rather than bolted on here.
- **Type consistency:** `SourceResult`/`SeoSource` defined once (T2) and used by T3/T4/T5; `PsiResult` from T1 flows into `PsiPayload`; `SeoRepo` interface (T2) matches the fake in T4's tests method-for-method; `RANKMATH_ABILITIES` keys are exactly the five non-PSI `SeoSource` values.
- **Judgment calls:** inline SVG sparkline instead of adding Recharts (one small component vs a dependency); 120s per-ability timeout because the live link report exceeded 10s; PSI partial success (one strategy failing) still records `ok` with a reason so the page shows what it has.
