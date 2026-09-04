# DataForSEO Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: ROADMAP — approved, parked, not started.** Nothing here has been
built. Pick it up by starting at Task 1; the plan assumes no memory of the
conversation that produced it. Spec: `docs/superpowers/specs/2026-09-04-dataforseo-seo-expansion-design.md`.

**Goal:** Add backlink data to the panel from DataForSEO, behind a provider port with a spend ledger and budget caps that make every metered call visible and refusable before it runs.

**Architecture:** A provider port (`ExternalSeoProvider`) with two implementations — a deterministic stub used in dev and every test, and a DataForSEO adapter. A new `seo_external_scan` job type runs the provider and writes results into the existing `seo_snapshots` table, whose `source` column is unconstrained free text. Two new tables: `dataforseo_spend` (a ledger of every metered call) and `seo_keyword_cache` (unused in these phases; created now because it belongs in the same migration). Phase 0 is entirely stub-driven and cannot spend money; Phase 1 adds the live adapter and the UI.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (Postgres + PostgREST), Vitest, Tailwind v4, `dataforseo-client` (added in Task 7).

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-09-04-dataforseo-seo-expansion-design.md`. Every task's requirements implicitly include these.

- New sources are named `backlinks`, `ranked_keywords`, `serp_competitors`, `keyword_research`, and `ai_search`. **This plan implements only `backlinks`**; the others are declared in the type union so later phases need no type change.
- `ai_search` deliberately differs from the existing `ai_visibility` "so the two can coexist and be compared rather than one silently overwriting the other". Never rename or merge them.
- `seo_snapshots` needs **no migration** for new sources — `source` is `text not null` with no constraint (`supabase/migrations/0001_init.sql:83`).
- `estimate()` is **pure and does no network I/O**: "the budget check must be answerable without spending money."
- Two caps, per-site monthly and global monthly. Over cap ⇒ "the job fails with a plain reason (`\"Monthly budget for this site is spent\"`), it does not silently skip or half-run."
- `dataforseo_spend` is **not granted to `authenticated`** — staff-only, read through the service-role client, same class as `mcp_endpoint`.
- `cost_usd` is `numeric(10,6)` — "six decimals: individual calls are ~$0.0006".
- Confirmation threshold for operator-initiated spend starts at **$1.00**.
- Reference cost: backlinks domain overview ≈ **$0.08**.
- Principle 4 binds: "a site with no backlink snapshot must render 'not yet measured', never '0 referring domains'."
- UI: skeleton on load, empty state distinguishing *never fetched* from *fetched and empty*, and `showInlineError` stays default-true — "do not reintroduce the opt-out."
- Per project memory: run `/impeccable` after each UI phase; responsive is mandatory.

**Migration numbering:** `0020` is the next free number. Verify with `ls supabase/migrations/` before writing; if `0020_*` exists, use the next free number consistently across every task.

**Deploy order:** migration `0020` must be applied **before** deploying code that reads the new tables. PostgREST rejects a select naming an unknown column and fails the whole query.

---

## File Structure

**Created:**
- `supabase/migrations/0020_dataforseo_spend.sql` — spend ledger + keyword cache
- `src/services/seo/external-types.ts` — the port, payload types, cost types
- `src/services/seo/providers/stub.ts` — deterministic provider
- `src/services/seo/providers/dataforseo.ts` — live provider (Task 7+)
- `src/services/seo/providers/index.ts` — provider selection by env
- `src/services/seo/spend/ledger.ts` — record + query spend
- `src/services/seo/spend/budget.ts` — caps, pre-flight check
- `src/services/seo/collectExternal.ts` — the scan entry point
- `src/app/(dashboard)/sites/[id]/seo/backlinks-card.tsx` — UI
- `tests/seo-external-provider.test.ts`
- `tests/seo-spend-budget.test.ts`
- `tests/seo-collect-external.test.ts`
- `tests/seo-backlinks-report.test.ts`

**Modified:**
- `src/services/seo/types.ts` — extend `SeoSource` union
- `src/services/jobs/types.ts` — add `seo_external_scan`
- `src/services/jobs/handlers.ts` — register the handler
- `src/app/api/cron/enqueue/route.ts` — monthly enqueue
- `src/app/(dashboard)/sites/[id]/seo/page.tsx` — render the card
- `src/services/reports/types.ts`, `gather.ts`, `document.tsx` — report section
- `.env.example` — document new env vars

---

## Task 1: Migration 0020 — spend ledger and keyword cache

**Files:**
- Create: `supabase/migrations/0020_dataforseo_spend.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `dataforseo_spend` and `seo_keyword_cache`, read by Tasks 3 and 4.

- [ ] **Step 1: Confirm 0020 is free**

```bash
ls supabase/migrations/ | tail -3
```

Expected: highest is `0019_site_origin_override.sql`. If `0020_*` exists, use the next free number everywhere in this plan.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0020_dataforseo_spend.sql`:

```sql
-- Phase 0 of the DataForSEO SEO expansion
-- (docs/superpowers/specs/2026-09-04-dataforseo-seo-expansion-design.md).
--
-- Two tables, neither of which stores SEO results: snapshots continue to go
-- into seo_snapshots, whose `source` column is unconstrained text, so new
-- sources need no schema change at all.
--
-- dataforseo_spend is the answer to the one serious criticism in every
-- review of this class of tool: usage billing is unpredictable at agency
-- scale. Every metered call is recorded here, so "what did SEO data cost us
-- this month" is a query rather than a support ticket to a vendor.
--
-- DEPLOY ORDER: apply before deploying code that reads these tables.
-- PostgREST rejects a select naming an unknown column and fails the whole
-- query, not just that field. `if not exists` makes this re-runnable.

set local search_path = public;

create table if not exists dataforseo_spend (
  id uuid primary key default gen_random_uuid(),
  -- Null for a call not attributable to one site (a global keyword lookup).
  site_id uuid references sites(id) on delete set null,
  -- The SeoSource that caused the spend, e.g. 'backlinks'.
  source text not null,
  -- The DataForSEO endpoint, kept verbatim so a surprising invoice line can
  -- be traced back to the code path that caused it.
  endpoint text not null,
  -- Whatever the endpoint charges by: SERPs, rows, pages.
  units int not null default 1,
  -- Six decimal places is not fussiness: a single SERP call costs $0.0006,
  -- so numeric(10,2) would round every one of them to zero and the ledger
  -- would report nothing while real money was spent.
  cost_usd numeric(10,6) not null,
  -- True when cost came from our own estimate because the response did not
  -- report one. Kept so a reconciliation against the real invoice can tell
  -- measured rows from inferred ones.
  estimated boolean not null default false,
  -- Null when a scheduled job spent it; set when a person clicked a button.
  actor uuid,
  job_id uuid references jobs(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists dataforseo_spend_created_idx
  on dataforseo_spend (created_at desc);
create index if not exists dataforseo_spend_site_created_idx
  on dataforseo_spend (site_id, created_at desc);

-- Keyword metrics are stable for weeks and cost ~$0.05 a lookup. Without a
-- cache, re-sorting a results table would re-bill every row.
-- Created here rather than in a later migration because it belongs to the
-- same feature; Phase 2 fills it.
create table if not exists seo_keyword_cache (
  keyword text not null,
  location_code int not null,
  language_code text not null,
  search_volume int,
  difficulty int,
  cpc numeric(10,4),
  competition numeric(5,4),
  intent text,
  fetched_at timestamptz not null default now(),
  primary key (keyword, location_code, language_code)
);

-- NOT granted to `authenticated`. 0012 replaced the table-level grant on
-- credential-adjacent data with an explicit column list precisely so this
-- class of row stays off it. Spend describes agency cost, not client data;
-- it is read through the service-role client by staff surfaces only.

comment on table dataforseo_spend is
  'One row per metered DataForSEO call. Powers the monthly budget caps and '
  'the admin spend view. Never exposed to the authenticated role.';
comment on table seo_keyword_cache is
  'Keyword metrics cache. TTL is a read-time decision (default 30 days), '
  'not a delete job.';
```

- [ ] **Step 3: Verify the SQL parses**

There is no local Postgres in this project. Check by eye against
`supabase/migrations/0019_site_origin_override.sql` for style, then confirm
the file is non-empty and contains both tables:

```bash
grep -c "create table if not exists" supabase/migrations/0020_dataforseo_spend.sql
```

Expected: `2`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0020_dataforseo_spend.sql
git commit -m "feat(db): spend ledger and keyword cache for DataForSEO"
```

- [ ] **Step 5: Hand the migration to the operator**

This migration must be applied by hand in the Supabase SQL editor before any
task that reads these tables is deployed. Note it in the task report; do not
assume it has been applied.

---

## Task 2: The provider port and payload types

**Files:**
- Create: `src/services/seo/external-types.ts`
- Modify: `src/services/seo/types.ts`
- Test: `tests/seo-external-provider.test.ts`

**Interfaces:**
- Consumes: `SourceResult<T>` from `src/services/seo/types.ts`.
- Produces:
  - `type ExternalSeoSource = "backlinks" | "ranked_keywords" | "serp_competitors" | "keyword_research" | "ai_search"`
  - `interface BacklinksPayload { domain: string; referringDomains: number; backlinks: number; brokenBacklinks: number; newBacklinks: number; lostBacklinks: number; newReferringDomains: number; lostReferringDomains: number; rank: number | null; capturedAt: string }`
  - `interface PlannedCall { source: ExternalSeoSource; units: number }`
  - `interface CostEstimate { costUsd: number; endpoint: string; units: number }`
  - `interface ExternalSeoProvider { name: "stub" | "dataforseo"; backlinks(domain: string): Promise<SourceResult<BacklinksPayload>>; estimate(call: PlannedCall): CostEstimate }`

- [ ] **Step 1: Extend the SeoSource union**

In `src/services/seo/types.ts`, replace the `SeoSource` type and
`SEO_SOURCES` const with:

```ts
/**
 * Sources that come from Rank Math over the site's own MCP connection. Free:
 * they run against a site we already manage.
 */
export type RankMathSeoSource =
  | "rankmath_audit" | "rankmath_scores" | "links" | "keywords" | "ai_visibility" | "psi";

/**
 * Sources that come from DataForSEO. Every one of these costs money, so they
 * travel through the spend ledger and the budget check.
 *
 * `ai_search` is deliberately NOT named `ai_visibility`: Rank Math already
 * provides that, free, and the two measure different things. Keeping both
 * names lets them be compared rather than one silently overwriting the other.
 */
export type ExternalSeoSource =
  | "backlinks" | "ranked_keywords" | "serp_competitors" | "keyword_research" | "ai_search";

export type SeoSource = RankMathSeoSource | ExternalSeoSource;

export const SEO_SOURCES: RankMathSeoSource[] = [
  "rankmath_audit", "rankmath_scores", "links", "keywords", "ai_visibility", "psi",
];

export const EXTERNAL_SEO_SOURCES: ExternalSeoSource[] = [
  "backlinks", "ranked_keywords", "serp_competitors", "keyword_research", "ai_search",
];
```

Leave every other export in that file untouched.

- [ ] **Step 2: Write the failing test**

Create `tests/seo-external-provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { stubExternalProvider } from "@/services/seo/providers/stub";
import { EXTERNAL_SEO_SOURCES } from "@/services/seo/types";

describe("external SEO source naming", () => {
  it("keeps ai_search distinct from Rank Math's ai_visibility", () => {
    // They measure different things and one must never overwrite the other.
    expect(EXTERNAL_SEO_SOURCES).toContain("ai_search");
    expect(EXTERNAL_SEO_SOURCES as string[]).not.toContain("ai_visibility");
  });
});

describe("stubExternalProvider", () => {
  it("returns a backlinks payload shaped like the real one", async () => {
    const res = await stubExternalProvider.backlinks("example.com");
    expect(res.source).toBe("backlinks");
    expect(res.status).toBe("ok");
    expect(res.data?.domain).toBe("example.com");
    expect(typeof res.data?.referringDomains).toBe("number");
    expect(typeof res.data?.backlinks).toBe("number");
  });

  it("is deterministic — the same domain gives the same numbers", async () => {
    // Tests and dev screenshots must not churn between runs.
    const a = await stubExternalProvider.backlinks("example.com");
    const b = await stubExternalProvider.backlinks("example.com");
    expect(a.data).toEqual(b.data);
  });

  it("gives different domains different numbers", async () => {
    const a = await stubExternalProvider.backlinks("example.com");
    const b = await stubExternalProvider.backlinks("other.test");
    expect(a.data?.referringDomains).not.toBe(b.data?.referringDomains);
  });

  it("estimates without doing any I/O", () => {
    const est = stubExternalProvider.estimate({ source: "backlinks", units: 1 });
    expect(est.costUsd).toBeGreaterThan(0);
    expect(est.endpoint).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/seo-external-provider.test.ts
```

Expected: FAIL — cannot resolve `@/services/seo/providers/stub`.

- [ ] **Step 4: Write the port**

Create `src/services/seo/external-types.ts`:

```ts
import type { ExternalSeoSource, SourceResult } from "./types";

/**
 * A backlink profile summary for one domain.
 *
 * Deliberately a summary and not a list of links: the panel's job is to show
 * a client whether their link profile is growing, and a list of ten thousand
 * URLs answers a different question at a much higher price.
 */
export interface BacklinksPayload {
  domain: string;
  referringDomains: number;
  backlinks: number;
  brokenBacklinks: number;
  newBacklinks: number;
  lostBacklinks: number;
  newReferringDomains: number;
  lostReferringDomains: number;
  /** Provider's own domain-authority-style score, null when not reported. */
  rank: number | null;
  capturedAt: string;
}

/** A call we are about to make, for costing before it happens. */
export interface PlannedCall {
  source: ExternalSeoSource;
  /** SERPs, rows or pages — whatever this endpoint bills by. */
  units: number;
}

export interface CostEstimate {
  costUsd: number;
  /** The endpoint this would hit, recorded in the ledger for invoice tracing. */
  endpoint: string;
  units: number;
}

/**
 * The only interface anything above `providers/` may depend on.
 *
 * `estimate` is synchronous and pure on purpose: the budget check has to be
 * answerable without spending money, so it must never reach the network.
 */
export interface ExternalSeoProvider {
  name: "stub" | "dataforseo";
  backlinks(domain: string): Promise<SourceResult<BacklinksPayload>>;
  estimate(call: PlannedCall): CostEstimate;
}
```

- [ ] **Step 5: Write the stub provider**

Create `src/services/seo/providers/stub.ts`:

```ts
import type { BacklinksPayload, CostEstimate, ExternalSeoProvider, PlannedCall } from "../external-types";
import type { SourceResult } from "../types";

/** Small deterministic string hash (FNV-1a, 32-bit). */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h >>> 0);
}

/**
 * Deterministic stand-in for DataForSEO. Default in dev and in every test.
 *
 * Determinism is the point: screenshots, fixtures and assertions must not
 * churn between runs, and nobody should need a funded API account to work on
 * the UI. Numbers are seeded from the domain so different sites look
 * different while any one site looks the same every time.
 */
export const stubExternalProvider: ExternalSeoProvider = {
  name: "stub",

  async backlinks(domain: string): Promise<SourceResult<BacklinksPayload>> {
    const seed = hash(domain);
    const referringDomains = 20 + (seed % 400);
    return {
      source: "backlinks",
      status: "ok",
      data: {
        domain,
        referringDomains,
        // Real profiles have many links per referring domain.
        backlinks: referringDomains * (3 + (seed % 12)),
        brokenBacklinks: seed % 9,
        newBacklinks: seed % 25,
        lostBacklinks: (seed >> 3) % 15,
        newReferringDomains: seed % 7,
        lostReferringDomains: (seed >> 5) % 5,
        rank: 10 + (seed % 60),
        capturedAt: new Date().toISOString(),
      },
    };
  },

  estimate(call: PlannedCall): CostEstimate {
    // Mirrors the real provider's prices so budget behaviour is identical in
    // dev and production. Keep these two tables in step.
    const PRICES: Record<PlannedCall["source"], { usd: number; endpoint: string }> = {
      backlinks: { usd: 0.08, endpoint: "backlinks/summary/live" },
      ranked_keywords: { usd: 0.05, endpoint: "dataforseo_labs/google/ranked_keywords/live" },
      serp_competitors: { usd: 0.05, endpoint: "dataforseo_labs/google/serp_competitors/live" },
      keyword_research: { usd: 0.05, endpoint: "dataforseo_labs/google/keyword_suggestions/live" },
      ai_search: { usd: 1.09, endpoint: "ai_optimization/llm_mentions/live" },
    };
    const p = PRICES[call.source];
    return { costUsd: p.usd * call.units, endpoint: p.endpoint, units: call.units };
  },
};
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/seo-external-provider.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no output. If `SEO_SOURCES` is consumed somewhere expecting the
full union, fix the call site to use `SEO_SOURCES` (Rank Math only) — that is
the correct meaning; the external sources are collected by a different path.

- [ ] **Step 8: Commit**

```bash
git add src/services/seo/external-types.ts src/services/seo/providers/stub.ts src/services/seo/types.ts tests/seo-external-provider.test.ts
git commit -m "feat(seo): external provider port with a deterministic stub"
```

---

## Task 3: Spend ledger

**Files:**
- Create: `src/services/seo/spend/ledger.ts`
- Test: covered by Task 4's test file (the budget check is the only consumer worth testing through)

**Interfaces:**
- Consumes: `dataforseo_spend` table from Task 1.
- Produces:
  - `interface SpendEntry { siteId: string | null; source: ExternalSeoSource; endpoint: string; units: number; costUsd: number; estimated: boolean; actor?: string | null; jobId?: string | null }`
  - `interface SpendLedger { record(e: SpendEntry): Promise<void>; monthToDate(siteId: string | null): Promise<number>; globalMonthToDate(): Promise<number> }`
  - `function supabaseSpendLedger(db: SupabaseClient): SpendLedger`

- [ ] **Step 1: Write the ledger**

Create `src/services/seo/spend/ledger.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExternalSeoSource } from "../types";

export interface SpendEntry {
  /** Null for a call not attributable to one site. */
  siteId: string | null;
  source: ExternalSeoSource;
  endpoint: string;
  units: number;
  costUsd: number;
  /** True when this came from estimate() because the response reported none. */
  estimated: boolean;
  actor?: string | null;
  jobId?: string | null;
}

export interface SpendLedger {
  record(entry: SpendEntry): Promise<void>;
  /** Spend for one site since the start of the current UTC month. */
  monthToDate(siteId: string | null): Promise<number>;
  /** Spend across every site since the start of the current UTC month. */
  globalMonthToDate(): Promise<number>;
}

/** First instant of the current UTC month, as an ISO string. */
export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function supabaseSpendLedger(db: SupabaseClient): SpendLedger {
  async function sum(filter: (q: ReturnType<typeof baseQuery>) => typeof q): Promise<number> {
    const { data, error } = await filter(baseQuery());
    if (error) throw new Error(`spend query failed: ${error.message}`, { cause: error });
    // Summed in JS rather than with a Postgres aggregate: PostgREST's
    // aggregate support needs explicit opt-in per project, and a month of
    // spend rows for twelve sites is small enough that the round trip is the
    // cost, not the arithmetic.
    return (data ?? []).reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
  }

  function baseQuery() {
    return db
      .from("dataforseo_spend")
      .select("cost_usd")
      .gte("created_at", monthStartIso());
  }

  return {
    async record(entry) {
      const { error } = await db.from("dataforseo_spend").insert({
        site_id: entry.siteId,
        source: entry.source,
        endpoint: entry.endpoint,
        units: entry.units,
        cost_usd: entry.costUsd,
        estimated: entry.estimated,
        actor: entry.actor ?? null,
        job_id: entry.jobId ?? null,
      });
      if (error) throw new Error(`spend insert failed: ${error.message}`, { cause: error });
    },

    async monthToDate(siteId) {
      return sum((q) => (siteId === null ? q.is("site_id", null) : q.eq("site_id", siteId)));
    },

    async globalMonthToDate() {
      return sum((q) => q);
    },
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/services/seo/spend/ledger.ts
git commit -m "feat(seo): spend ledger for metered DataForSEO calls"
```

---

## Task 4: Budget caps and the pre-flight check

**Files:**
- Create: `src/services/seo/spend/budget.ts`
- Modify: `.env.example`
- Test: `tests/seo-spend-budget.test.ts`

**Interfaces:**
- Consumes: `SpendLedger` (Task 3), `CostEstimate` (Task 2).
- Produces:
  - `class BudgetExceededError extends Error`
  - `interface BudgetCaps { perSiteUsd: number; globalUsd: number }`
  - `function readBudgetCaps(): BudgetCaps`
  - `async function assertWithinBudget(ledger: SpendLedger, siteId: string | null, estimate: CostEstimate, caps?: BudgetCaps): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/seo-spend-budget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertWithinBudget, BudgetExceededError, type BudgetCaps,
} from "@/services/seo/spend/budget";
import type { SpendLedger } from "@/services/seo/spend/ledger";

function fakeLedger(site: number, global: number): SpendLedger {
  return {
    async record() {},
    async monthToDate() { return site; },
    async globalMonthToDate() { return global; },
  };
}

const CAPS: BudgetCaps = { perSiteUsd: 5, globalUsd: 25 };
const EST = { costUsd: 0.08, endpoint: "backlinks/summary/live", units: 1 };

describe("assertWithinBudget", () => {
  it("allows a call that fits under both caps", async () => {
    await expect(
      assertWithinBudget(fakeLedger(1, 5), "site-1", EST, CAPS),
    ).resolves.toBeUndefined();
  });

  it("refuses when the site cap would be exceeded, naming the site cap", async () => {
    // Spec: over cap the job fails with a plain reason, it does not silently
    // skip or half-run.
    await expect(
      assertWithinBudget(fakeLedger(4.99, 5), "site-1", EST, CAPS),
    ).rejects.toThrow(BudgetExceededError);
    await expect(
      assertWithinBudget(fakeLedger(4.99, 5), "site-1", EST, CAPS),
    ).rejects.toThrow(/budget for this site/i);
  });

  it("refuses when the global cap would be exceeded, naming the global cap", async () => {
    await expect(
      assertWithinBudget(fakeLedger(0, 24.99), "site-1", EST, CAPS),
    ).rejects.toThrow(/overall .*budget/i);
  });

  it("counts the estimate itself, not just spend already recorded", async () => {
    // At exactly the cap with nothing spent yet, a call that would cross it
    // must be refused before it happens — the ledger only knows the past.
    const big = { costUsd: 1, endpoint: "x", units: 1 };
    await expect(
      assertWithinBudget(fakeLedger(4.5, 0), "site-1", big, CAPS),
    ).rejects.toThrow(BudgetExceededError);
  });

  it("applies only the global cap to a call with no site", async () => {
    await expect(
      assertWithinBudget(fakeLedger(0, 1), null, EST, CAPS),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/seo-spend-budget.test.ts
```

Expected: FAIL — cannot resolve `@/services/seo/spend/budget`.

- [ ] **Step 3: Write the budget module**

Create `src/services/seo/spend/budget.ts`:

```ts
import { getOptionalEnv } from "@/lib/env";
import type { CostEstimate } from "../external-types";
import type { SpendLedger } from "./ledger";

/**
 * Thrown when a call would cross a monthly cap.
 *
 * A distinct class rather than a bare Error so a caller can tell "we chose
 * not to spend this" from "the provider failed" — they need different
 * messages and only one of them is worth retrying.
 */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetCaps {
  perSiteUsd: number;
  globalUsd: number;
}

/** Defaults are the spec's suggested starting caps. */
export const DEFAULT_CAPS: BudgetCaps = { perSiteUsd: 5, globalUsd: 25 };

function num(name: string, fallback: number): number {
  const raw = getOptionalEnv(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // A malformed cap must not silently become Infinity or NaN — either would
  // disable the protection this module exists to provide.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readBudgetCaps(): BudgetCaps {
  return {
    perSiteUsd: num("SEO_BUDGET_SITE_USD", DEFAULT_CAPS.perSiteUsd),
    globalUsd: num("SEO_BUDGET_GLOBAL_USD", DEFAULT_CAPS.globalUsd),
  };
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Refuses a call that would cross either cap, before it is made.
 *
 * The estimate is added to spend already recorded rather than compared
 * against it: the ledger only knows the past, and a call that fits under the
 * cap today can still be the one that crosses it.
 */
export async function assertWithinBudget(
  ledger: SpendLedger,
  siteId: string | null,
  estimate: CostEstimate,
  caps: BudgetCaps = readBudgetCaps(),
): Promise<void> {
  if (siteId !== null) {
    const spent = await ledger.monthToDate(siteId);
    if (spent + estimate.costUsd > caps.perSiteUsd) {
      throw new BudgetExceededError(
        `Monthly SEO data budget for this site is spent — ${money(spent)} of ` +
          `${money(caps.perSiteUsd)} used, and this would add ${money(estimate.costUsd)}.`,
      );
    }
  }

  const global = await ledger.globalMonthToDate();
  if (global + estimate.costUsd > caps.globalUsd) {
    throw new BudgetExceededError(
      `Monthly overall SEO data budget is spent — ${money(global)} of ` +
        `${money(caps.globalUsd)} used, and this would add ${money(estimate.costUsd)}.`,
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/seo-spend-budget.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Document the env vars**

Append to `.env.example`:

```
# Monthly caps on DataForSEO spend, in US dollars. A call that would cross
# either cap is refused before it is made, with a message naming which cap.
# Defaults if unset: 5 per site, 25 overall.
SEO_BUDGET_SITE_USD=5
SEO_BUDGET_GLOBAL_USD=25

# Which external SEO provider to use. `stub` returns deterministic fixtures
# and costs nothing; it is the default and what tests and dev should use.
# `dataforseo` makes real, billed calls and needs DATAFORSEO_API_KEY.
SEO_EXTERNAL_PROVIDER=stub

# DataForSEO credentials, base64 of "email:api_password".
# See docs/superpowers/specs/2026-09-04-dataforseo-seo-expansion-design.md
DATAFORSEO_API_KEY=
```

- [ ] **Step 6: Commit**

```bash
git add src/services/seo/spend/budget.ts tests/seo-spend-budget.test.ts .env.example
git commit -m "feat(seo): monthly budget caps with a pre-flight refusal"
```

---

## Task 5: Provider selection and the external collector

**Files:**
- Create: `src/services/seo/providers/index.ts`
- Create: `src/services/seo/collectExternal.ts`
- Test: `tests/seo-collect-external.test.ts`

**Interfaces:**
- Consumes: `ExternalSeoProvider` (Task 2), `SpendLedger` (Task 3), `assertWithinBudget` (Task 4), `SeoRepo` from `src/services/seo/repo.ts`, `SitesRepo` from `src/services/sites/repo.ts`.
- Produces:
  - `function selectExternalProvider(): ExternalSeoProvider`
  - `interface ExternalScanDeps { sites: SitesRepo; seo: SeoRepo; ledger: SpendLedger; provider?: ExternalSeoProvider }`
  - `async function externalSeoScan(deps: ExternalScanDeps, siteId: string, sources: ExternalSeoSource[], opts?: { jobId?: string; actor?: string }): Promise<{ takenAt: string; results: SourceResult[] }>`

- [ ] **Step 1: Write the failing test**

Create `tests/seo-collect-external.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { externalSeoScan } from "@/services/seo/collectExternal";
import { stubExternalProvider } from "@/services/seo/providers/stub";
import type { SpendLedger } from "@/services/seo/spend/ledger";
import type { SourceResult } from "@/services/seo/types";

function deps(over: Partial<{ site: number; global: number }> = {}) {
  const recorded: unknown[] = [];
  const inserted: { siteId: string; takenAt: string; results: SourceResult[] }[] = [];
  const ledger: SpendLedger = {
    async record(e) { recorded.push(e); },
    async monthToDate() { return over.site ?? 0; },
    async globalMonthToDate() { return over.global ?? 0; },
  };
  return {
    recorded,
    inserted,
    d: {
      sites: {
        getSite: async () => ({ id: "site-1", url: "https://example.com/", name: "Example" }),
      } as never,
      seo: {
        insertSnapshots: async (siteId: string, takenAt: string, results: SourceResult[]) => {
          inserted.push({ siteId, takenAt, results });
        },
      } as never,
      ledger,
      provider: stubExternalProvider,
    },
  };
}

describe("externalSeoScan", () => {
  it("stores a snapshot under the backlinks source", async () => {
    const { d, inserted } = deps();
    const out = await externalSeoScan(d, "site-1", ["backlinks"]);
    expect(out.results[0].source).toBe("backlinks");
    expect(out.results[0].status).toBe("ok");
    expect(inserted).toHaveLength(1);
    expect(inserted[0].results[0].source).toBe("backlinks");
  });

  it("records spend for a successful call", async () => {
    const { d, recorded } = deps();
    await externalSeoScan(d, "site-1", ["backlinks"], { jobId: "job-1" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      siteId: "site-1", source: "backlinks", units: 1, jobId: "job-1",
    });
  });

  it("refuses and records nothing when the budget is spent", async () => {
    const { d, recorded } = deps({ site: 999 });
    await expect(externalSeoScan(d, "site-1", ["backlinks"]))
      .rejects.toThrow(/budget/i);
    // Nothing was called, so nothing may be billed.
    expect(recorded).toHaveLength(0);
  });

  it("strips the scheme and trailing slash before asking for a domain", async () => {
    // DataForSEO wants a bare domain; a URL silently returns nothing useful.
    const { d } = deps();
    const spy = vi.spyOn(stubExternalProvider, "backlinks");
    await externalSeoScan(d, "site-1", ["backlinks"]);
    expect(spy).toHaveBeenCalledWith("example.com");
    spy.mockRestore();
  });

  it("does not bill for a source it cannot run", async () => {
    const { d, recorded } = deps();
    const out = await externalSeoScan(d, "site-1", ["ranked_keywords"]);
    expect(out.results[0].status).toBe("skipped");
    expect(recorded).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/seo-collect-external.test.ts
```

Expected: FAIL — cannot resolve `@/services/seo/collectExternal`.

- [ ] **Step 3: Write provider selection**

Create `src/services/seo/providers/index.ts`:

```ts
import { getOptionalEnv } from "@/lib/env";
import type { ExternalSeoProvider } from "../external-types";
import { stubExternalProvider } from "./stub";

/**
 * Picks the provider from SEO_EXTERNAL_PROVIDER.
 *
 * Defaults to the stub, deliberately. A missing or misspelt env var must
 * never fall through to the provider that spends money; the failure mode of
 * "dev sees fixtures" is cheap, and the opposite is not.
 */
export function selectExternalProvider(): ExternalSeoProvider {
  if (getOptionalEnv("SEO_EXTERNAL_PROVIDER") === "dataforseo") {
    // Imported lazily so the stub path never loads the client or requires a key.
    // Replaced with a real import in Task 7.
    throw new Error(
      "SEO_EXTERNAL_PROVIDER=dataforseo but the DataForSEO provider is not built yet (Task 7).",
    );
  }
  return stubExternalProvider;
}
```

- [ ] **Step 4: Write the collector**

Create `src/services/seo/collectExternal.ts`:

```ts
import type { SitesRepo } from "@/services/sites/repo";
import type { ExternalSeoProvider } from "./external-types";
import { selectExternalProvider } from "./providers";
import type { SeoRepo } from "./repo";
import { assertWithinBudget } from "./spend/budget";
import type { SpendLedger } from "./spend/ledger";
import type { ExternalSeoSource, SourceResult } from "./types";

export interface ExternalScanDeps {
  sites: SitesRepo;
  seo: SeoRepo;
  ledger: SpendLedger;
  /** Injected in tests; production selects from env. */
  provider?: ExternalSeoProvider;
}

/**
 * DataForSEO wants a bare registrable domain. Handing it a full URL returns
 * nothing useful and still bills for the call, so normalise before asking.
 */
export function toDomain(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "");
}

/**
 * Runs the metered SEO sources for one site and stores the results.
 *
 * Deliberately separate from `seoScan` (the Rank Math path). That one is
 * per-site MCP and free; this one is a global metered API that can refuse on
 * budget. Sharing an entry point would mean a spent budget breaks the free
 * on-site scan, and a WordPress connection failure blocks paid data we could
 * still fetch. They fail independently, so they run independently.
 */
export async function externalSeoScan(
  deps: ExternalScanDeps,
  siteId: string,
  sources: ExternalSeoSource[],
  opts: { jobId?: string; actor?: string } = {},
): Promise<{ takenAt: string; results: SourceResult[] }> {
  const site = await deps.sites.getSite(siteId);
  if (!site) throw new Error(`Site not found: ${siteId}`);

  const provider = deps.provider ?? selectExternalProvider();
  const domain = toDomain(site.url);
  const results: SourceResult[] = [];

  for (const source of sources) {
    if (source !== "backlinks") {
      // Declared in the union for later phases but not implemented yet.
      // Reported honestly rather than silently dropped, and never billed.
      results.push({
        source,
        status: "skipped",
        reason: `${source} is not implemented yet`,
      });
      continue;
    }

    const estimate = provider.estimate({ source, units: 1 });
    // Throws BudgetExceededError, which the job handler surfaces verbatim.
    // Deliberately before the call: a refusal must cost nothing.
    await assertWithinBudget(deps.ledger, siteId, estimate);

    const result = await provider.backlinks(domain);
    results.push(result);

    // Only bill for a call that actually happened. A provider error still
    // consumed a request at the vendor in some cases, but we cannot know
    // that from here, and over-reporting spend is the worse error: it would
    // eat a budget that was never charged.
    if (result.status === "ok") {
      await deps.ledger.record({
        siteId,
        source,
        endpoint: estimate.endpoint,
        units: estimate.units,
        costUsd: estimate.costUsd,
        estimated: true,
        actor: opts.actor ?? null,
        jobId: opts.jobId ?? null,
      });
    }
  }

  const takenAt = new Date().toISOString();
  await deps.seo.insertSnapshots(siteId, takenAt, results);
  return { takenAt, results };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/seo-collect-external.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Run the whole suite and typecheck**

```bash
npx tsc --noEmit && npx vitest run tests/
```

Expected: no tsc output; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/seo/providers/index.ts src/services/seo/collectExternal.ts tests/seo-collect-external.test.ts
git commit -m "feat(seo): external scan collector with budget refusal before spend"
```

---

## Task 6: The `seo_external_scan` job type

**Files:**
- Modify: `src/services/jobs/types.ts`
- Modify: `src/services/jobs/handlers.ts`
- Modify: `src/app/api/cron/enqueue/route.ts`

**Interfaces:**
- Consumes: `externalSeoScan` (Task 5), `supabaseSpendLedger` (Task 3).
- Produces: job type `"seo_external_scan"` with payload `{ sources?: ExternalSeoSource[] }`, defaulting to `["backlinks"]`.

- [ ] **Step 1: Add the job type**

In `src/services/jobs/types.ts`, add `"seo_external_scan"` to the `JobType`
union, on the line with `"seo_scan"`:

```ts
  | "plugin_install" | "seo_scan" | "seo_external_scan" | "geogrid_run" | "report_generate"
```

- [ ] **Step 2: Register the handler**

In `src/services/jobs/handlers.ts`, add immediately after the `seo_scan`
entry:

```ts
    seo_external_scan: async ({ job }) => {
      if (!job.site_id) throw new Error("seo_external_scan requires site_id");
      const p = job.payload as { sources?: ExternalSeoSource[] };
      // Defaults to backlinks: the only source implemented, and the one the
      // monthly cron asks for. An explicit list lets a person run one source
      // without paying for the others.
      const sources = Array.isArray(p?.sources) && p.sources.length > 0
        ? p.sources
        : (["backlinks"] as ExternalSeoSource[]);
      await externalSeoScan(
        { sites, seo, ledger: supabaseSpendLedger(db) },
        job.site_id,
        sources,
        { jobId: job.id },
      );
    },
```

Add the imports at the top of the file, beside the existing `seoScan` import:

```ts
import { externalSeoScan } from "@/services/seo/collectExternal";
import { supabaseSpendLedger } from "@/services/seo/spend/ledger";
import type { ExternalSeoSource } from "@/services/seo/types";
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no output. If it complains that `sites` or `seo` is not in scope,
read the surrounding `buildJobHandlers` signature and use the same repo
variables `seo_scan` uses on the line above.

- [ ] **Step 4: Enqueue monthly from the cron**

In `src/app/api/cron/enqueue/route.ts`, find the line that enqueues
`seo_scan` (around line 41) and add a monthly external scan beside it.
Insert after the `seo_scan` enqueue, inside the same per-site block:

```ts
    // Backlinks change slowly and cost ~$0.08 a site, so monthly rather than
    // nightly: daily would be twelve times the price for data that has not
    // moved. Runs on the 1st; dedupe keeps a retry from double-billing.
    const backlinks = new Date().getUTCDate() === 1
      ? await enqueueJob(jobs, "seo_external_scan", site.id, { sources: ["backlinks"] }, { dedupe: true })
      : null;
```

Then include it in the response summary alongside the existing counters —
find the `return` with `{ ok: true, sites: ... }` and add
`backlinks: perSite.filter((r) => r.backlinks).length,` using whatever
accumulator shape the surrounding code already uses. Read the file and match
it rather than assuming.

- [ ] **Step 5: Typecheck and run the suite**

```bash
npx tsc --noEmit && npx vitest run tests/
```

Expected: no tsc output; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/jobs/types.ts src/services/jobs/handlers.ts "src/app/api/cron/enqueue/route.ts"
git commit -m "feat(jobs): seo_external_scan job type, enqueued monthly"
```

**Phase 0 ends here.** Everything above runs on the stub and cannot spend
money. It is safe to merge and deploy before a DataForSEO account exists.

---

## Task 7: The DataForSEO provider

**Files:**
- Create: `src/services/seo/providers/dataforseo.ts`
- Modify: `src/services/seo/providers/index.ts`
- Modify: `package.json` (adds `dataforseo-client`)
- Test: `tests/seo-external-provider.test.ts` (extend)

**Interfaces:**
- Consumes: `ExternalSeoProvider`, `BacklinksPayload`, `CostEstimate` (Task 2).
- Produces: `function createDataForSeoProvider(opts?: { fetchImpl?: typeof fetch }): ExternalSeoProvider`

**Prerequisite:** a funded DataForSEO account and `DATAFORSEO_API_KEY` set
(base64 of `email:api_password`, minimum deposit $50). Do not start this task
without one — every step below needs it.

- [ ] **Step 1: Add the dependency**

```bash
npm install dataforseo-client --save
```

- [ ] **Step 2: Write the failing test**

Append to `tests/seo-external-provider.test.ts`:

```ts
import { createDataForSeoProvider } from "@/services/seo/providers/dataforseo";

describe("createDataForSeoProvider", () => {
  const OK_RESPONSE = {
    tasks: [{
      result: [{
        target: "example.com",
        rank: 42,
        backlinks: 1234,
        referring_domains: 56,
        broken_backlinks: 7,
        new_backlinks: 8,
        lost_backlinks: 9,
        new_referring_domains: 2,
        lost_referring_domains: 1,
      }],
    }],
  };

  function fetchReturning(status: number, body: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  }

  it("maps a summary response onto BacklinksPayload", async () => {
    const p = createDataForSeoProvider({ fetchImpl: fetchReturning(200, OK_RESPONSE) });
    const res = await p.backlinks("example.com");
    expect(res.status).toBe("ok");
    expect(res.data).toMatchObject({
      domain: "example.com",
      referringDomains: 56,
      backlinks: 1234,
      brokenBacklinks: 7,
      rank: 42,
    });
  });

  it("returns an error result rather than throwing on an HTTP failure", async () => {
    // A failed source must not abort the whole scan or the other sources.
    const p = createDataForSeoProvider({ fetchImpl: fetchReturning(401, { message: "nope" }) });
    const res = await p.backlinks("example.com");
    expect(res.status).toBe("error");
    expect(res.data).toBeUndefined();
  });

  it("returns an error result when the task list is empty", async () => {
    const p = createDataForSeoProvider({ fetchImpl: fetchReturning(200, { tasks: [] }) });
    const res = await p.backlinks("example.com");
    expect(res.status).toBe("error");
  });

  it("prices backlinks identically to the stub", async () => {
    // The two price tables must agree or budget behaviour differs between
    // dev and production, which is the worst place to discover a mismatch.
    const live = createDataForSeoProvider({ fetchImpl: fetchReturning(200, OK_RESPONSE) });
    expect(live.estimate({ source: "backlinks", units: 1 }).costUsd)
      .toBe(stubExternalProvider.estimate({ source: "backlinks", units: 1 }).costUsd);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/seo-external-provider.test.ts
```

Expected: FAIL — cannot resolve `@/services/seo/providers/dataforseo`.

- [ ] **Step 4: Write the provider**

Create `src/services/seo/providers/dataforseo.ts`:

```ts
import { getOptionalEnv } from "@/lib/env";
import type { BacklinksPayload, CostEstimate, ExternalSeoProvider, PlannedCall } from "../external-types";
import type { SourceResult } from "../types";
import { stubExternalProvider } from "./stub";

const BASE = "https://api.dataforseo.com/v3";

/**
 * Reads the key, failing with a sentence rather than a 401 from the vendor.
 *
 * Deliberately NOT `getEnv`: that takes a closed `EnvName` union of the five
 * variables every deployment must have, and adding this one would make a
 * DataForSEO account mandatory for everyone — including anyone running the
 * stub, which is the whole point of Phase 0 being free.
 */
function apiKey(): string {
  const key = getOptionalEnv("DATAFORSEO_API_KEY");
  if (!key) {
    throw new Error(
      "DATAFORSEO_API_KEY is not set. Set it, or set SEO_EXTERNAL_PROVIDER=stub to use fixtures.",
    );
  }
  return key;
}

function int(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function intOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Live DataForSEO provider.
 *
 * Written against the REST endpoints directly rather than through the
 * generated client: we call exactly one endpoint in this phase, and the
 * generated client pulls in a large surface for no benefit. If later phases
 * need many endpoints, revisit.
 *
 * Every method returns a SourceResult rather than throwing. A single failed
 * source must not abort a scan that has other sources to collect, and the
 * caller decides whether a failure is worth billing for.
 */
export function createDataForSeoProvider(
  opts: { fetchImpl?: typeof fetch } = {},
): ExternalSeoProvider {
  const doFetch = opts.fetchImpl ?? fetch;

  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await doFetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        // The key is already base64 of "email:password" — see
        // docs/.../DATAFORSEO_API_KEY. Do not re-encode it.
        Authorization: `Basic ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DataForSEO ${path} returned ${res.status}`);
    return res.json();
  }

  return {
    name: "dataforseo",

    async backlinks(domain: string): Promise<SourceResult<BacklinksPayload>> {
      try {
        const raw = await post("/backlinks/summary/live", [
          { target: domain, internal_list_limit: 1, backlinks_status_type: "live" },
        ]);
        const result = (raw as { tasks?: { result?: unknown[] }[] })
          ?.tasks?.[0]?.result?.[0] as Record<string, unknown> | undefined;
        if (!result) {
          return { source: "backlinks", status: "error", reason: "No result returned for this domain" };
        }
        return {
          source: "backlinks",
          status: "ok",
          data: {
            domain,
            referringDomains: int(result.referring_domains),
            backlinks: int(result.backlinks),
            brokenBacklinks: int(result.broken_backlinks),
            newBacklinks: int(result.new_backlinks),
            lostBacklinks: int(result.lost_backlinks),
            newReferringDomains: int(result.new_referring_domains),
            lostReferringDomains: int(result.lost_referring_domains),
            rank: intOrNull(result.rank),
            capturedAt: new Date().toISOString(),
          },
        };
      } catch (e) {
        return {
          source: "backlinks",
          status: "error",
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    },

    // Prices are identical to the stub's by construction: one table, reused.
    // Two tables would drift, and budget behaviour would then differ between
    // dev and production.
    estimate(call: PlannedCall): CostEstimate {
      return stubExternalProvider.estimate(call);
    },
  };
}
```

- [ ] **Step 5: Wire it into selection**

Replace the body of `selectExternalProvider` in
`src/services/seo/providers/index.ts`:

```ts
export function selectExternalProvider(): ExternalSeoProvider {
  if (getOptionalEnv("SEO_EXTERNAL_PROVIDER") === "dataforseo") {
    return createDataForSeoProvider();
  }
  return stubExternalProvider;
}
```

and add `import { createDataForSeoProvider } from "./dataforseo";` at the top.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run tests/seo-external-provider.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 7: Verify against the live API once, by hand**

This is the only step in the plan that spends money (~$0.08). It is worth it:
a mapping bug found here costs eight cents, and found in production costs a
wrong number in a client report.

```bash
node -e '
const key = process.env.DATAFORSEO_API_KEY;
if (!key) { console.log("DATAFORSEO_API_KEY not set — skip"); process.exit(0); }
fetch("https://api.dataforseo.com/v3/backlinks/summary/live", {
  method: "POST",
  headers: { Authorization: "Basic " + key, "Content-Type": "application/json" },
  body: JSON.stringify([{ target: "elnidoguide.ph", internal_list_limit: 1, backlinks_status_type: "live" }]),
}).then(r => r.json()).then(j => {
  const r = j.tasks?.[0]?.result?.[0];
  console.log("status:", j.status_message, "| cost:", j.cost);
  console.log("referring_domains:", r?.referring_domains, "backlinks:", r?.backlinks, "rank:", r?.rank);
});'
```

Expected: a real referring-domain count and a `cost` field. **Record the
actual `cost` value in the task report** — if it differs from the $0.08
estimate, update the price table in `providers/stub.ts` so the budget stays
honest.

- [ ] **Step 8: Commit**

```bash
git add src/services/seo/providers/dataforseo.ts src/services/seo/providers/index.ts tests/seo-external-provider.test.ts package.json package-lock.json
git commit -m "feat(seo): live DataForSEO backlinks provider"
```

---

## Task 8: Backlinks card on the SEO tab

**Files:**
- Create: `src/app/(dashboard)/sites/[id]/seo/backlinks-card.tsx`
- Modify: `src/app/(dashboard)/sites/[id]/seo/page.tsx`

**Interfaces:**
- Consumes: `BacklinksPayload` (Task 2), `latestBySource()` from `src/services/seo/repo.ts`.
- Produces: `function BacklinksCard(props: { data: BacklinksPayload | null; note: string | null; takenAt: string | null }): JSX.Element`

- [ ] **Step 1: Read the page you are modifying**

```bash
sed -n '55,110p' "src/app/(dashboard)/sites/[id]/seo/page.tsx"
```

Note how `dataOf<T>(latest.<source>)` and `noteOf(latest.<source>)` are used —
the new card follows exactly that pattern.

- [ ] **Step 2: Write the card**

Create `src/app/(dashboard)/sites/[id]/seo/backlinks-card.tsx`:

```tsx
import { Card, CardTitle, EmptyState, Stat } from "@/components/ui/primitives";
import type { BacklinksPayload } from "@/services/seo/external-types";

/** "+12" / "−3" / "0", so a change reads as a direction at a glance. */
function delta(gained: number, lost: number): string {
  const net = gained - lost;
  if (net === 0) return "0";
  return net > 0 ? `+${net}` : `−${Math.abs(net)}`;
}

/**
 * Inbound links to this site, from DataForSEO.
 *
 * Distinct from the "Links" card beside it, which counts internal and
 * external links *on* the site's own pages via Rank Math. This one counts
 * who links *to* the site — a different question, a different source, and
 * the one clients actually ask about.
 *
 * `data === null` is never rendered as zero. A site nobody has measured and a
 * site with no backlinks are different facts, and this audience cannot tell
 * them apart from a "0".
 */
export function BacklinksCard({
  data, note, takenAt,
}: {
  data: BacklinksPayload | null;
  note: string | null;
  takenAt: string | null;
}) {
  return (
    <Card className="mb-4">
      <CardTitle>Backlinks</CardTitle>
      {!data ? (
        <div className="px-5 pb-5">
          <EmptyState title="Not measured yet">
            {note ?? "Backlink data is collected monthly. Nothing has been collected for this site yet."}
          </EmptyState>
        </div>
      ) : (
        <div className="p-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Referring domains" value={String(data.referringDomains)} />
            <Stat label="Total backlinks" value={String(data.backlinks)} />
            <Stat
              label="Referring domains, net change"
              value={delta(data.newReferringDomains, data.lostReferringDomains)}
            />
            <Stat label="Broken links" value={String(data.brokenBacklinks)} />
          </div>
          {takenAt && (
            <p className="mt-4 text-caption tracking-normal text-mid-gray">
              Collected {new Date(takenAt).toLocaleDateString()}.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 3: Render it on the page**

In `src/app/(dashboard)/sites/[id]/seo/page.tsx`:

Add the import beside the other local imports:

```tsx
import { BacklinksCard } from "./backlinks-card";
import type { BacklinksPayload } from "@/services/seo/external-types";
```

Add the data read beside the other `dataOf` lines (near line 62-67):

```tsx
  const backlinks = dataOf<BacklinksPayload>(latest.backlinks);
```

Render the card immediately after the existing "Links" card. Find where
`links` is rendered and place `<BacklinksCard ... />` after that card's
closing tag:

```tsx
      <BacklinksCard
        data={backlinks ?? null}
        note={noteOf(latest.backlinks) ?? null}
        takenAt={latest.backlinks?.taken_at ?? null}
      />
```

- [ ] **Step 4: Typecheck and build**

```bash
npx tsc --noEmit && npm run build
```

Expected: no tsc output; build compiles.

- [ ] **Step 5: Verify in the browser**

Start the dev server and open a site's SEO tab. With
`SEO_EXTERNAL_PROVIDER=stub` and no snapshot yet, the card must read **"Not
measured yet"**, never "0 referring domains". Check at 375px width too —
responsive is mandatory.

- [ ] **Step 6: Run the impeccable audit**

Per project memory, run `/impeccable` on the SEO tab after this UI lands and
fix what it reports before committing.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/sites/[id]/seo/backlinks-card.tsx" "src/app/(dashboard)/sites/[id]/seo/page.tsx"
git commit -m "feat(seo): backlinks card on the site SEO tab"
```

---

## Task 9: Backlinks in the client report

**Files:**
- Modify: `src/services/reports/types.ts`
- Modify: `src/services/reports/gather.ts`
- Modify: `src/services/reports/document.tsx`
- Test: `tests/seo-backlinks-report.test.ts`

**Interfaces:**
- Consumes: `BacklinksPayload` (Task 2), the existing report `seo` section shape.
- Produces: `seo.backlinks: { referringDomains: number; backlinks: number; netReferringDomains: number } | null` on the report data object.

- [ ] **Step 1: Read the existing report seo section**

```bash
grep -n "seo" src/services/reports/types.ts | head -20
grep -n "seo" src/services/reports/gather.ts | head -20
```

Match the shape and naming already used; do not invent a parallel convention.

- [ ] **Step 2: Write the failing test**

Create `tests/seo-backlinks-report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOC = readFileSync(join(process.cwd(), "src", "services", "reports", "document.tsx"), "utf8");

describe("backlinks in the client report", () => {
  it("renders referring domains", () => {
    expect(DOC).toContain("referringDomains");
  });

  it("never prints a bare zero for an unmeasured profile", () => {
    // Principle 4: unmeasured and zero are different facts, and this is the
    // audience least able to tell them apart. The null branch must exist.
    expect(DOC).toMatch(/backlinks\s*(\?\.|&&|===\s*null|\?)/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/seo-backlinks-report.test.ts
```

Expected: FAIL — `referringDomains` is not in `document.tsx`.

- [ ] **Step 4: Add the field to the report type**

In `src/services/reports/types.ts`, inside the existing `seo` section type,
add:

```ts
    /** Null when no backlink snapshot has ever been taken for this site. */
    backlinks: {
      referringDomains: number;
      backlinks: number;
      netReferringDomains: number;
    } | null;
```

- [ ] **Step 5: Populate it in gather.ts**

In `src/services/reports/gather.ts`, where the `seo` section is assembled,
read the latest `backlinks` snapshot from the same `latestBySource()` result
the other SEO fields use and map it:

```ts
    backlinks: (() => {
      const raw = latest.backlinks?.payload as
        { status?: string; data?: BacklinksPayload } | undefined;
      const d = raw?.status === "ok" ? raw.data : undefined;
      // Absent stays absent. Reporting zero for a site nobody has measured
      // would be the single most misleading number in the document.
      if (!d) return null;
      return {
        referringDomains: d.referringDomains,
        backlinks: d.backlinks,
        netReferringDomains: d.newReferringDomains - d.lostReferringDomains,
      };
    })(),
```

Add `import type { BacklinksPayload } from "@/services/seo/external-types";`
at the top.

- [ ] **Step 6: Render it in document.tsx**

In the existing `{seo && ( ... )}` block, after the `Row` for "Last scan",
add:

```tsx
            {seo.backlinks ? (
              <>
                <Row label="Referring domains" value={String(seo.backlinks.referringDomains)} />
                <Row label="Total backlinks" value={String(seo.backlinks.backlinks)} />
                <Row
                  label="Referring domains gained this period"
                  value={
                    seo.backlinks.netReferringDomains >= 0
                      ? `+${seo.backlinks.netReferringDomains}`
                      : String(seo.backlinks.netReferringDomains)
                  }
                />
              </>
            ) : (
              <Row label="Referring domains" value="Not measured yet" />
            )}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run tests/seo-backlinks-report.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 8: Generate a report and read it**

Generate a report for a site that has a stub backlinks snapshot, and one for
a site that has none. Confirm the second says "Not measured yet" and not "0".

- [ ] **Step 9: Run the whole suite, typecheck and build**

```bash
npx tsc --noEmit && npx vitest run tests/ && npm run build
```

Expected: no tsc output; all tests pass; build compiles.

- [ ] **Step 10: Commit**

```bash
git add src/services/reports/types.ts src/services/reports/gather.ts src/services/reports/document.tsx tests/seo-backlinks-report.test.ts
git commit -m "feat(reports): backlinks in the client report"
```

---

## Task 10: Update the spec's status

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-dataforseo-seo-expansion-design.md`

- [ ] **Step 1: Mark the phases done**

Change the header `Status: approved design, not started` to
`Status: Phase 0 and Phase 1 shipped <date>; Phases 2-4 not started`.

In §8, mark Phase 0 and Phase 1 complete, and record the **actual** measured
cost per backlinks call from Task 7 Step 7 beside the $0.08 estimate.

- [ ] **Step 2: Note what the next person needs**

Add under Phase 2: whether the location-code question from §10 was answered
during Phase 1, and what value was used.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-04-dataforseo-seo-expansion-design.md
git commit -m "docs: record Phase 0 and Phase 1 as shipped"
```

---

## Self-Review

**Spec coverage.** §3 architecture → Tasks 2, 5, 7. §4 data model → Task 1.
§5 budget and spend → Tasks 3, 4, and the refusal path in Task 5. §6 UI →
Task 8. §7 reports → Task 9. §8 Phase 0 → Tasks 1-6; Phase 1 → Tasks 7-9.
Phases 2-4 and the deferred items are deliberately out of scope.

**Not covered, and deliberately so:** the admin Spend card from §5
("Visibility"). It reads the ledger Task 3 builds but shows nothing until
real spend exists, so it belongs with Phase 2 when there is more than one
source to break down. Flagged here rather than silently dropped.

**Type consistency.** `BacklinksPayload` is defined once in Task 2 and used
verbatim in Tasks 5, 7, 8, 9. `ExternalSeoProvider.estimate` is synchronous
in every task. `SpendLedger` has the same three methods in Tasks 3, 4, 5.
`selectExternalProvider()` throws in Task 5 and returns the real provider in
Task 7 — deliberate, and Task 7 Step 5 replaces it.

**Placeholders:** none. Every code step carries the code.
