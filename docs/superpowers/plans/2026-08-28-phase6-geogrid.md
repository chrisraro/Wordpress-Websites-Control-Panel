# Phase 6: GeoGrid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-site local-rank GeoGrid: configure a business, keywords, and an N×N grid; run scans that plot Google Maps ranking at each coordinate on a real map; compare runs over time. Ranks come from a provider adapter — a deterministic stub out of the box, or the team's n8n instance via webhook + signed callback.

**Architecture:** A `geogrid_run` job per (config, keyword). The stub provider computes ranks inline and finishes the job. The n8n provider POSTs the grid to a webhook and parks the job in `awaiting_callback`; n8n posts results back to a signed callback route, which writes the snapshot and completes the job. A watchdog fails callbacks that never arrive. The map is Leaflet loaded client-side only.

**Tech Stack:** Existing stack + `leaflet@1.9.4` and `@types/leaflet` (map rendering only; no react-leaflet — a small `useEffect` wrapper avoids React-version coupling).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md` §6.7. GeoGrid touches no WordPress site — it never opens an MCP client.
- Grid math: odd `grid_size` ∈ {3,5,7,9}; points are offset from the center by `spacing_m`, latitude degrees = `metres / 111_320`, longitude degrees = `metres / (111_320 * cos(centerLatRadians))`; index order is row-major from north-west to south-east; the exact center is always a point.
- Rank semantics: `rank` is `1..20` for a found position, `null` for "not in the local pack". Provider must return one entry per requested point, in the same order.
- **Callback auth:** the route accepts either an HMAC-SHA256 signature of the raw body in `x-n8n-signature` (hex, optional `sha256=` prefix) **or** a timing-safe match of `x-n8n-secret` against `N8N_WEBHOOK_SECRET`. Both prove possession of the shared secret; the bearer form exists because it is one header field in n8n. Reject everything else with 401. (Documented deviation from the spec's HMAC-only line.)
- Env (all optional — the stub provider needs none): `N8N_GEOGRID_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `APP_URL` (public origin used to build the callback URL sent to n8n).
- Jobs: new `JobType` `"geogrid_run"`. A handler may return `{ awaitingCallback: true }`, which parks the job in `awaiting_callback` instead of marking it done. `/api/cron/process` first fails any `awaiting_callback` job older than **30 minutes** (its normal retry/backoff then applies).
- `run_id` sent to n8n **is the job id**; the callback matches on it and refuses jobs that are not `geogrid_run` in `awaiting_callback`.
- Config writes and manual runs: `requireUser()`-gated, confirm dialog for runs, activity logged (`site.geogrid_config`, `site.geogrid_run`).
- Responsive + a11y as established (`overflow-x-auto` tables, `min-h-10` targets, labelled inputs, `aria-live` errors, never colour alone — rank pins carry their number as text).
- Commit after every task; PowerShell-safe commands.

## File Structure (new/changed)

```
.env.example                                        # + N8N_*, APP_URL
package.json                                        # + leaflet, @types/leaflet
src/services/geogrid/grid.ts                        # buildGrid, gridBounds
src/services/geogrid/types.ts                       # config/point/provider types
src/services/geogrid/repo.ts                        # GeoGridRepo + supabase impl
src/services/geogrid/providers/stub.ts              # deterministic provider
src/services/geogrid/providers/n8n.ts               # webhook provider
src/services/geogrid/run.ts                         # runGeoGrid orchestrator + completeGeoGridRun
src/services/jobs/{types,repo,service,handlers}.ts  # geogrid_run + awaiting_callback plumbing
src/app/api/cron/process/route.ts                   # watchdog call
src/app/api/webhooks/n8n/geogrid/route.ts           # signed callback
src/app/(dashboard)/sites/[id]/geogrid-actions.ts   # save config, run, provider switch
src/app/(dashboard)/sites/[id]/geogrid/page.tsx     # tab page
src/app/(dashboard)/sites/[id]/geogrid/config-form.tsx
src/app/(dashboard)/sites/[id]/geogrid/grid-map.tsx # Leaflet client component
src/app/(dashboard)/sites/[id]/tabs.tsx             # GeoGrid → LIVE
docs/ops/n8n-geogrid-workflow.json                  # importable workflow
docs/ops/geogrid.md                                 # setup guide
tests/{geogrid-grid,geogrid-providers,geogrid-run,geogrid-callback}.test.ts
```

---

### Task 1: Grid math + types (TDD)

**Files:**
- Create: `src/services/geogrid/types.ts`, `src/services/geogrid/grid.ts`
- Test: `tests/geogrid-grid.test.ts`

**Interfaces:**
- Produces:
```ts
// types.ts
export type GeoGridProviderName = "stub" | "n8n";
export interface GeoGridConfig {
  id: string; site_id: string; business_name: string; place_ref: string | null;
  keywords: string[]; grid_size: number; spacing_m: number;
  center_lat: number; center_lng: number; provider: GeoGridProviderName; created_at: string;
}
export interface GridPoint { idx: number; lat: number; lng: number }
export interface RankPoint extends GridPoint { rank: number | null }
export interface GeoGridSnapshot { id: string; config_id: string; run_at: string; keyword: string; points: RankPoint[] }
export interface ProviderRequest {
  runId: string; keyword: string; businessName: string; placeRef: string | null;
  points: GridPoint[]; callbackUrl: string;
}
export type ProviderOutcome = { kind: "ranks"; ranks: RankPoint[] } | { kind: "awaiting" };
export interface GeoGridProvider { name: GeoGridProviderName; run(req: ProviderRequest): Promise<ProviderOutcome> }
export function averageRank(points: RankPoint[]): number | null;   // mean of found ranks, 1 decimal; null if none found
export function coverage(points: RankPoint[]): number;             // % of points with a rank, 0 decimals

// grid.ts
export function buildGrid(centerLat: number, centerLng: number, size: number, spacingM: number): GridPoint[];
export function gridBounds(points: GridPoint[]): { south: number; west: number; north: number; east: number };
```

- [ ] **Step 1: Write the failing tests**

`tests/geogrid-grid.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildGrid, gridBounds } from "@/services/geogrid/grid";
import { averageRank, coverage, type RankPoint } from "@/services/geogrid/types";

describe("buildGrid", () => {
  it("builds N*N points with the centre exactly in the middle", () => {
    const pts = buildGrid(14.5995, 120.9842, 3, 1000);
    expect(pts).toHaveLength(9);
    expect(pts.map((p) => p.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const centre = pts[4];
    expect(centre.lat).toBeCloseTo(14.5995, 9);
    expect(centre.lng).toBeCloseTo(120.9842, 9);
  });

  it("orders points north-west to south-east, row major", () => {
    const pts = buildGrid(10, 20, 3, 1000);
    expect(pts[0].lat).toBeGreaterThan(pts[6].lat);   // first row north of last row
    expect(pts[0].lng).toBeLessThan(pts[2].lng);      // first column west of last column
    expect(pts[0].lat).toBeCloseTo(pts[1].lat, 9);    // same row shares latitude
    expect(pts[0].lng).toBeCloseTo(pts[3].lng, 9);    // same column shares longitude
  });

  it("spaces points by the requested metres", () => {
    const spacing = 1000;
    const pts = buildGrid(0, 0, 3, spacing);          // at the equator cos(0)=1
    const dLat = pts[1 * 3].lat - pts[0 * 3 + 3].lat; // adjacent rows
    expect(Math.abs(pts[0].lat - pts[3].lat)).toBeCloseTo(spacing / 111_320, 6);
    expect(Math.abs(pts[0].lng - pts[1].lng)).toBeCloseTo(spacing / 111_320, 6);
    expect(dLat).toBeCloseTo(0, 9);
  });

  it("widens longitude spacing away from the equator", () => {
    const equator = buildGrid(0, 0, 3, 1000);
    const north = buildGrid(60, 0, 3, 1000);
    const dLngEq = Math.abs(equator[0].lng - equator[1].lng);
    const dLngN = Math.abs(north[0].lng - north[1].lng);
    expect(dLngN).toBeGreaterThan(dLngEq * 1.9);      // 1/cos(60°) = 2
  });

  it("rejects invalid sizes", () => {
    for (const bad of [0, 2, 4, 11, -3]) {
      expect(() => buildGrid(0, 0, bad, 1000)).toThrow(/grid size/i);
    }
    expect(() => buildGrid(0, 0, 5, 0)).toThrow(/spacing/i);
  });
});

describe("gridBounds", () => {
  it("returns the enclosing box", () => {
    const b = gridBounds(buildGrid(10, 20, 3, 1000));
    expect(b.north).toBeGreaterThan(b.south);
    expect(b.east).toBeGreaterThan(b.west);
    expect((b.north + b.south) / 2).toBeCloseTo(10, 6);
    expect((b.east + b.west) / 2).toBeCloseTo(20, 6);
  });
});

describe("averageRank / coverage", () => {
  const pts: RankPoint[] = [
    { idx: 0, lat: 0, lng: 0, rank: 1 },
    { idx: 1, lat: 0, lng: 0, rank: 4 },
    { idx: 2, lat: 0, lng: 0, rank: null },
    { idx: 3, lat: 0, lng: 0, rank: 10 },
  ];
  it("averages only found ranks", () => {
    expect(averageRank(pts)).toBe(5);
  });
  it("reports coverage as a whole percentage", () => {
    expect(coverage(pts)).toBe(75);
  });
  it("handles an all-missing grid", () => {
    const none: RankPoint[] = [{ idx: 0, lat: 0, lng: 0, rank: null }];
    expect(averageRank(none)).toBeNull();
    expect(coverage(none)).toBe(0);
    expect(coverage([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/geogrid-grid.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement types.ts**

`src/services/geogrid/types.ts`:
```ts
export type GeoGridProviderName = "stub" | "n8n";

export interface GeoGridConfig {
  id: string;
  site_id: string;
  business_name: string;
  place_ref: string | null;
  keywords: string[];
  grid_size: number;
  spacing_m: number;
  center_lat: number;
  center_lng: number;
  provider: GeoGridProviderName;
  created_at: string;
}

export interface GridPoint { idx: number; lat: number; lng: number }
export interface RankPoint extends GridPoint { rank: number | null }

export interface GeoGridSnapshot {
  id: string;
  config_id: string;
  run_at: string;
  keyword: string;
  points: RankPoint[];
}

export interface ProviderRequest {
  runId: string;
  keyword: string;
  businessName: string;
  placeRef: string | null;
  points: GridPoint[];
  callbackUrl: string;
}

export type ProviderOutcome =
  | { kind: "ranks"; ranks: RankPoint[] }
  | { kind: "awaiting" };

export interface GeoGridProvider {
  name: GeoGridProviderName;
  run(req: ProviderRequest): Promise<ProviderOutcome>;
}

export function averageRank(points: RankPoint[]): number | null {
  const found = points.filter((p) => typeof p.rank === "number").map((p) => p.rank as number);
  if (found.length === 0) return null;
  const mean = found.reduce((a, b) => a + b, 0) / found.length;
  return Math.round(mean * 10) / 10;
}

export function coverage(points: RankPoint[]): number {
  if (points.length === 0) return 0;
  const found = points.filter((p) => typeof p.rank === "number").length;
  return Math.round((found / points.length) * 100);
}
```

- [ ] **Step 4: Implement grid.ts**

`src/services/geogrid/grid.ts`:
```ts
import type { GridPoint } from "./types";

const METRES_PER_DEGREE_LAT = 111_320;
const ALLOWED_SIZES = new Set([3, 5, 7, 9]);

/**
 * Row-major grid from north-west to south-east, centred on the given point.
 * Longitude spacing widens with latitude so cells stay square on the ground.
 */
export function buildGrid(
  centerLat: number, centerLng: number, size: number, spacingM: number,
): GridPoint[] {
  if (!ALLOWED_SIZES.has(size)) {
    throw new Error(`Invalid grid size: ${size} (expected 3, 5, 7 or 9)`);
  }
  if (!Number.isFinite(spacingM) || spacingM <= 0) {
    throw new Error(`Invalid spacing: ${spacingM} (expected metres greater than zero)`);
  }
  const half = (size - 1) / 2;
  const dLat = spacingM / METRES_PER_DEGREE_LAT;
  const cos = Math.cos((centerLat * Math.PI) / 180);
  // Near the poles cos() approaches 0; clamp so longitude spacing stays finite.
  const dLng = spacingM / (METRES_PER_DEGREE_LAT * Math.max(Math.abs(cos), 1e-6));

  const points: GridPoint[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      points.push({
        idx: row * size + col,
        lat: centerLat + (half - row) * dLat,
        lng: centerLng + (col - half) * dLng,
      });
    }
  }
  return points;
}

export function gridBounds(points: GridPoint[]): {
  south: number; west: number; north: number; east: number;
} {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  return {
    south: Math.min(...lats), north: Math.max(...lats),
    west: Math.min(...lngs), east: Math.max(...lngs),
  };
}
```

- [ ] **Step 5: Run to verify pass, commit**

Run: `npm test` → green (117 + 9 new); `npx tsc --noEmit` → 0 errors.

```powershell
git add src/services/geogrid tests/geogrid-grid.test.ts; git commit -m "feat: geogrid coordinate math and rank statistics"
```

---

### Task 2: GeoGrid repo (configs + snapshots)

**Files:**
- Create: `src/services/geogrid/repo.ts`

**Interfaces:**
- Consumes: `GeoGridConfig`, `GeoGridSnapshot`, `RankPoint` (Task 1); tables `geogrid_configs`, `geogrid_snapshots` (migration 0001).
- Produces:
```ts
export interface GeoGridConfigInput {
  business_name: string; place_ref: string | null; keywords: string[];
  grid_size: number; spacing_m: number; center_lat: number; center_lng: number;
  provider: GeoGridProviderName;
}
export interface GeoGridRepo {
  getConfigBySite(siteId: string): Promise<GeoGridConfig | null>;
  getConfig(configId: string): Promise<GeoGridConfig | null>;
  upsertConfig(siteId: string, input: GeoGridConfigInput): Promise<GeoGridConfig>;  // one config per site
  insertSnapshot(configId: string, keyword: string, points: RankPoint[]): Promise<void>;
  latestPerKeyword(configId: string): Promise<Record<string, GeoGridSnapshot>>;
  historyForKeyword(configId: string, keyword: string, limit?: number): Promise<GeoGridSnapshot[]>; // newest first
}
export function supabaseGeoGridRepo(db: SupabaseClient): GeoGridRepo;
```

- [ ] **Step 1: Implement**

`src/services/geogrid/repo.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  GeoGridConfig, GeoGridProviderName, GeoGridSnapshot, RankPoint,
} from "./types";

export interface GeoGridConfigInput {
  business_name: string;
  place_ref: string | null;
  keywords: string[];
  grid_size: number;
  spacing_m: number;
  center_lat: number;
  center_lng: number;
  provider: GeoGridProviderName;
}

export interface GeoGridRepo {
  getConfigBySite(siteId: string): Promise<GeoGridConfig | null>;
  getConfig(configId: string): Promise<GeoGridConfig | null>;
  upsertConfig(siteId: string, input: GeoGridConfigInput): Promise<GeoGridConfig>;
  insertSnapshot(configId: string, keyword: string, points: RankPoint[]): Promise<void>;
  latestPerKeyword(configId: string): Promise<Record<string, GeoGridSnapshot>>;
  historyForKeyword(configId: string, keyword: string, limit?: number): Promise<GeoGridSnapshot[]>;
}

const CONFIG_COLUMNS =
  "id,site_id,business_name,place_ref,keywords,grid_size,spacing_m,center_lat,center_lng,provider,created_at";

export function supabaseGeoGridRepo(db: SupabaseClient): GeoGridRepo {
  return {
    async getConfigBySite(siteId) {
      const { data, error } = await db.from("geogrid_configs").select(CONFIG_COLUMNS)
        .eq("site_id", siteId).order("created_at").limit(1).maybeSingle();
      if (error) throw new Error(`getConfigBySite failed: ${error.message}`, { cause: error });
      return (data as GeoGridConfig) ?? null;
    },
    async getConfig(configId) {
      const { data, error } = await db.from("geogrid_configs").select(CONFIG_COLUMNS)
        .eq("id", configId).maybeSingle();
      if (error) throw new Error(`getConfig failed: ${error.message}`, { cause: error });
      return (data as GeoGridConfig) ?? null;
    },
    async upsertConfig(siteId, input) {
      const existing = await this.getConfigBySite(siteId);
      const row = { site_id: siteId, ...input };
      const query = existing
        ? db.from("geogrid_configs").update(row).eq("id", existing.id)
        : db.from("geogrid_configs").insert(row);
      const { data, error } = await query.select(CONFIG_COLUMNS).single();
      if (error) throw new Error(`upsertConfig failed: ${error.message}`, { cause: error });
      return data as GeoGridConfig;
    },
    async insertSnapshot(configId, keyword, points) {
      const { error } = await db.from("geogrid_snapshots")
        .insert({ config_id: configId, keyword, points });
      if (error) throw new Error(`insertSnapshot failed: ${error.message}`, { cause: error });
    },
    async latestPerKeyword(configId) {
      const { data, error } = await db.from("geogrid_snapshots")
        .select("id,config_id,run_at,keyword,points").eq("config_id", configId)
        .order("run_at", { ascending: false }).limit(200);
      if (error) throw new Error(`latestPerKeyword failed: ${error.message}`, { cause: error });
      const out: Record<string, GeoGridSnapshot> = {};
      for (const row of (data ?? []) as GeoGridSnapshot[]) {
        if (!out[row.keyword]) out[row.keyword] = row;
      }
      return out;
    },
    async historyForKeyword(configId, keyword, limit = 10) {
      const { data, error } = await db.from("geogrid_snapshots")
        .select("id,config_id,run_at,keyword,points")
        .eq("config_id", configId).eq("keyword", keyword)
        .order("run_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`historyForKeyword failed: ${error.message}`, { cause: error });
      return (data ?? []) as GeoGridSnapshot[];
    },
  };
}
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit` → 0 errors; `npm test` → green (repo is thin query code, exercised through Task 4's fakes).

```powershell
git add src/services/geogrid/repo.ts; git commit -m "feat: geogrid config and snapshot repository"
```

---

### Task 3: Providers — stub and n8n (TDD)

**Files:**
- Create: `src/services/geogrid/providers/stub.ts`, `src/services/geogrid/providers/n8n.ts`
- Modify: `.env.example`
- Test: `tests/geogrid-providers.test.ts`

**Interfaces:**
- Consumes: `GeoGridProvider`, `ProviderRequest`, `ProviderOutcome`, `RankPoint` (Task 1); `getOptionalEnv`.
- Produces:
```ts
// stub.ts
export const stubProvider: GeoGridProvider;   // name "stub", deterministic ranks, always {kind:"ranks"}
// n8n.ts
export function createN8nProvider(fetchImpl?: typeof fetch): GeoGridProvider; // name "n8n", always {kind:"awaiting"}
// POSTs JSON { run_id, keyword, business: { name, place_ref }, points, callback_url }
// headers: content-type + x-n8n-secret (when N8N_WEBHOOK_SECRET set)
// throws when N8N_GEOGRID_WEBHOOK_URL is unset or the POST is not ok
```
Stub rank rule (deterministic, plausible): hash `keyword|idx` to a 0-99 value; rank = `1 + (hash % 3) + distanceRings` where `distanceRings` is the Chebyshev ring index from the grid centre; ranks above 20 become `null`.

- [ ] **Step 1: Write the failing tests**

`tests/geogrid-providers.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { stubProvider } from "@/services/geogrid/providers/stub";
import { createN8nProvider } from "@/services/geogrid/providers/n8n";
import { buildGrid } from "@/services/geogrid/grid";
import type { ProviderRequest } from "@/services/geogrid/types";

afterEach(() => {
  delete process.env.N8N_GEOGRID_WEBHOOK_URL;
  delete process.env.N8N_WEBHOOK_SECRET;
});

function req(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    keyword: "coffee shop",
    businessName: "Test Cafe",
    placeRef: null,
    points: buildGrid(14.6, 120.98, 3, 1000),
    callbackUrl: "https://panel.test/api/webhooks/n8n/geogrid",
    ...over,
  };
}

describe("stubProvider", () => {
  it("returns one rank per point, in order", async () => {
    const r = await stubProvider.run(req());
    expect(r.kind).toBe("ranks");
    if (r.kind !== "ranks") throw new Error("unreachable");
    expect(r.ranks).toHaveLength(9);
    expect(r.ranks.map((p) => p.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const p of r.ranks) {
      expect(p.rank === null || (p.rank >= 1 && p.rank <= 20)).toBe(true);
    }
  });

  it("is deterministic for the same keyword and grid", async () => {
    const a = await stubProvider.run(req());
    const b = await stubProvider.run(req());
    if (a.kind !== "ranks" || b.kind !== "ranks") throw new Error("unreachable");
    expect(a.ranks).toEqual(b.ranks);
  });

  it("varies by keyword", async () => {
    const a = await stubProvider.run(req({ keyword: "coffee shop" }));
    const b = await stubProvider.run(req({ keyword: "bakery" }));
    if (a.kind !== "ranks" || b.kind !== "ranks") throw new Error("unreachable");
    expect(a.ranks).not.toEqual(b.ranks);
  });

  it("ranks the centre at least as well as the corners", async () => {
    const r = await stubProvider.run(req({ points: buildGrid(14.6, 120.98, 5, 1000) }));
    if (r.kind !== "ranks") throw new Error("unreachable");
    const centre = r.ranks[12].rank ?? 99;
    const corner = r.ranks[0].rank ?? 99;
    expect(centre).toBeLessThanOrEqual(corner);
  });
});

describe("createN8nProvider", () => {
  it("posts the run payload and reports awaiting", async () => {
    process.env.N8N_GEOGRID_WEBHOOK_URL = "https://n8n.test/webhook/geogrid";
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    let seen: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
      };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const outcome = await createN8nProvider(fetchImpl).run(req());
    expect(outcome).toEqual({ kind: "awaiting" });
    expect(seen!.url).toBe("https://n8n.test/webhook/geogrid");
    expect(seen!.headers["x-n8n-secret"]).toBe("s3cret");
    expect(seen!.body).toMatchObject({
      run_id: "11111111-1111-4111-8111-111111111111",
      keyword: "coffee shop",
      business: { name: "Test Cafe", place_ref: null },
      callback_url: "https://panel.test/api/webhooks/n8n/geogrid",
    });
    expect((seen!.body as { points: unknown[] }).points).toHaveLength(9);
  });

  it("throws a clear error when the webhook URL is not configured", async () => {
    await expect(createN8nProvider().run(req())).rejects.toThrow(/N8N_GEOGRID_WEBHOOK_URL/);
  });

  it("throws when n8n rejects the request", async () => {
    process.env.N8N_GEOGRID_WEBHOOK_URL = "https://n8n.test/webhook/geogrid";
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(createN8nProvider(fetchImpl).run(req())).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/geogrid-providers.test.ts` → FAIL.

- [ ] **Step 3: Implement the stub provider**

`src/services/geogrid/providers/stub.ts`:
```ts
import type { GeoGridProvider, RankPoint } from "../types";

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
 * Deterministic stand-in for a real rank provider: ranks degrade with distance
 * from the centre, so the map looks like a plausible local-pack heat map.
 */
export const stubProvider: GeoGridProvider = {
  name: "stub",
  async run(req) {
    const size = Math.round(Math.sqrt(req.points.length));
    const half = (size - 1) / 2;
    const ranks: RankPoint[] = req.points.map((p) => {
      const row = Math.floor(p.idx / size);
      const col = p.idx % size;
      const ring = Math.max(Math.abs(row - half), Math.abs(col - half));
      const jitter = hash(`${req.keyword}|${p.idx}`) % 3;
      const rank = 1 + jitter + ring * 3;
      return { ...p, rank: rank > 20 ? null : rank };
    });
    return { kind: "ranks", ranks };
  },
};
```

- [ ] **Step 4: Implement the n8n provider**

`src/services/geogrid/providers/n8n.ts`:
```ts
import { getOptionalEnv } from "@/lib/env";
import type { GeoGridProvider } from "../types";

/**
 * Hands the grid to the team's n8n workflow and returns immediately; n8n posts
 * ranks back to the callback route, which completes the job.
 */
export function createN8nProvider(fetchImpl: typeof fetch = fetch): GeoGridProvider {
  return {
    name: "n8n",
    async run(req) {
      const url = getOptionalEnv("N8N_GEOGRID_WEBHOOK_URL");
      if (!url) {
        throw new Error("N8N_GEOGRID_WEBHOOK_URL is not configured — set it or use the stub provider");
      }
      const secret = getOptionalEnv("N8N_WEBHOOK_SECRET");
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-n8n-secret": secret } : {}),
        },
        body: JSON.stringify({
          run_id: req.runId,
          keyword: req.keyword,
          business: { name: req.businessName, place_ref: req.placeRef },
          points: req.points,
          callback_url: req.callbackUrl,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(`n8n webhook rejected the run: HTTP ${res.status}`);
      }
      return { kind: "awaiting" };
    },
  };
}
```

Append to `.env.example`:
```
# GeoGrid via n8n (optional — the built-in "stub" provider needs none of these).
# APP_URL is this app's public origin; it builds the callback URL sent to n8n.
APP_URL=
N8N_GEOGRID_WEBHOOK_URL=
N8N_WEBHOOK_SECRET=
```

- [ ] **Step 5: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.

```powershell
git add src/services/geogrid/providers .env.example tests/geogrid-providers.test.ts; git commit -m "feat: geogrid stub and n8n rank providers"
```

---

### Task 4: Awaiting-callback jobs + run orchestrator (TDD)

**Files:**
- Modify: `src/services/jobs/types.ts`, `src/services/jobs/repo.ts`, `src/services/jobs/service.ts`
- Create: `src/services/geogrid/run.ts`
- Test: `tests/geogrid-run.test.ts`

**Interfaces:**
- Produces:
```ts
// jobs/types.ts
export type JobType = "snapshot_refresh" | "security_scan" | "vuln_feed_refresh" | "plugin_install" | "seo_scan" | "geogrid_run";

// jobs/service.ts — CHANGED
export type JobHandler = (ctx: JobContext) => Promise<void | { awaitingCallback: true }>;
// processJobs: when a handler resolves { awaitingCallback: true } it calls repo.markAwaiting(job.id)
// and counts it as `awaiting` in the result: { claimed, done, failed, retried, awaiting }

// jobs/repo.ts — ADDED
markAwaiting(id: string): Promise<void>;                       // status -> awaiting_callback
getJob(id: string): Promise<JobRow | null>;
failStaleAwaiting(olderThanMs: number): Promise<number>;       // awaiting_callback older than cutoff -> failed, returns count

// geogrid/run.ts
export interface GeoGridRunDeps { geogrid: GeoGridRepo; providers: Record<GeoGridProviderName, GeoGridProvider>; appUrl: string }
export async function runGeoGrid(deps: GeoGridRunDeps, jobId: string, configId: string, keyword: string): Promise<{ awaiting: boolean }>;
export async function completeGeoGridRun(repo: GeoGridRepo, configId: string, keyword: string, ranks: RankPoint[]): Promise<void>;
```
`runGeoGrid`: loads the config (throws if missing), builds the grid, picks the provider by `config.provider`, calls it with `callbackUrl = ${appUrl}/api/webhooks/n8n/geogrid`; on `{kind:"ranks"}` writes the snapshot and returns `{awaiting:false}`; on `{kind:"awaiting"}` returns `{awaiting:true}` without writing.

- [ ] **Step 1: Write the failing tests**

`tests/geogrid-run.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { runGeoGrid, completeGeoGridRun, type GeoGridRunDeps } from "@/services/geogrid/run";
import { stubProvider } from "@/services/geogrid/providers/stub";
import type { GeoGridRepo } from "@/services/geogrid/repo";
import type { GeoGridConfig, GeoGridProvider, RankPoint } from "@/services/geogrid/types";

const CONFIG: GeoGridConfig = {
  id: "cfg-1", site_id: "site-1", business_name: "Test Cafe", place_ref: null,
  keywords: ["coffee shop"], grid_size: 3, spacing_m: 1000,
  center_lat: 14.6, center_lng: 120.98, provider: "stub", created_at: "2026-01-01T00:00:00Z",
};

function fakeRepo(config: GeoGridConfig | null = CONFIG) {
  const snapshots: Array<{ configId: string; keyword: string; points: RankPoint[] }> = [];
  const repo = {
    async getConfig() { return config; },
    async insertSnapshot(configId: string, keyword: string, points: RankPoint[]) {
      snapshots.push({ configId, keyword, points });
    },
  } as unknown as GeoGridRepo;
  return { repo, snapshots };
}

function deps(repo: GeoGridRepo, n8n?: GeoGridProvider): GeoGridRunDeps {
  const awaiting: GeoGridProvider = n8n ?? {
    name: "n8n",
    async run() { return { kind: "awaiting" }; },
  };
  return { geogrid: repo, providers: { stub: stubProvider, n8n: awaiting }, appUrl: "https://panel.test" };
}

describe("runGeoGrid", () => {
  it("writes a snapshot immediately for the stub provider", async () => {
    const f = fakeRepo();
    const res = await runGeoGrid(deps(f.repo), "job-1", "cfg-1", "coffee shop");
    expect(res).toEqual({ awaiting: false });
    expect(f.snapshots).toHaveLength(1);
    expect(f.snapshots[0].points).toHaveLength(9);
    expect(f.snapshots[0].keyword).toBe("coffee shop");
  });

  it("parks the run and writes nothing for the n8n provider", async () => {
    const f = fakeRepo({ ...CONFIG, provider: "n8n" });
    let received: { runId: string; callbackUrl: string } | null = null;
    const spy: GeoGridProvider = {
      name: "n8n",
      async run(req) { received = { runId: req.runId, callbackUrl: req.callbackUrl }; return { kind: "awaiting" }; },
    };
    const res = await runGeoGrid(deps(f.repo, spy), "job-9", "cfg-1", "coffee shop");
    expect(res).toEqual({ awaiting: true });
    expect(f.snapshots).toHaveLength(0);
    expect(received).toEqual({
      runId: "job-9",
      callbackUrl: "https://panel.test/api/webhooks/n8n/geogrid",
    });
  });

  it("throws when the config is gone", async () => {
    const f = fakeRepo(null);
    await expect(runGeoGrid(deps(f.repo), "job-1", "missing", "x")).rejects.toThrow(/config/i);
  });
});

describe("completeGeoGridRun", () => {
  it("stores the returned ranks", async () => {
    const f = fakeRepo();
    const ranks: RankPoint[] = [{ idx: 0, lat: 1, lng: 2, rank: 3 }];
    await completeGeoGridRun(f.repo, "cfg-1", "coffee shop", ranks);
    expect(f.snapshots[0]).toMatchObject({ configId: "cfg-1", keyword: "coffee shop", points: ranks });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/geogrid-run.test.ts` → FAIL.

- [ ] **Step 3: Extend the jobs layer**

`src/services/jobs/types.ts` — extend the union:
```ts
export type JobType =
  | "snapshot_refresh" | "security_scan" | "vuln_feed_refresh"
  | "plugin_install" | "seo_scan" | "geogrid_run";
```

`src/services/jobs/repo.ts` — add to the `JobsRepo` interface:
```ts
  markAwaiting(id: string): Promise<void>;
  getJob(id: string): Promise<JobRow | null>;
  failStaleAwaiting(olderThanMs: number): Promise<number>;
```
and to `supabaseJobsRepo`:
```ts
    async markAwaiting(id) {
      const { error } = await db.from("jobs").update({ status: "awaiting_callback" }).eq("id", id);
      if (error) throw new Error(`jobs.markAwaiting failed: ${error.message}`, { cause: error });
    },
    async getJob(id) {
      const { data, error } = await db.from("jobs").select("*").eq("id", id).maybeSingle();
      if (error) throw new Error(`jobs.getJob failed: ${error.message}`, { cause: error });
      return (data as JobRow) ?? null;
    },
    async failStaleAwaiting(olderThanMs) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const { data, error } = await db.from("jobs")
        .update({ status: "failed", last_error: "Callback never arrived", finished_at: new Date().toISOString() })
        .eq("status", "awaiting_callback").lt("started_at", cutoff).select("id");
      if (error) throw new Error(`jobs.failStaleAwaiting failed: ${error.message}`, { cause: error });
      return (data ?? []).length;
    },
```

`src/services/jobs/service.ts` — widen the handler type and honour the sentinel:
```ts
export type JobHandler = (ctx: JobContext) => Promise<void | { awaitingCallback: true }>;
```
and in `processJobs`, replace the success branch:
```ts
    try {
      const outcome = await handler({ job });
      if (outcome && typeof outcome === "object" && outcome.awaitingCallback) {
        await repo.markAwaiting(job.id);
        result.awaiting++;
      } else {
        await repo.markDone(job.id);
        result.done++;
      }
    } catch (e) {
```
and change the result initialiser and return type to include `awaiting`:
```ts
): Promise<{ claimed: number; done: number; failed: number; retried: number; awaiting: number }> {
  const jobs = await repo.claim(opts.max ?? 3);
  const result = { claimed: jobs.length, done: 0, failed: 0, retried: 0, awaiting: 0 };
```

- [ ] **Step 4: Implement run.ts**

`src/services/geogrid/run.ts`:
```ts
import { buildGrid } from "./grid";
import type { GeoGridRepo } from "./repo";
import type { GeoGridProvider, GeoGridProviderName, RankPoint } from "./types";

export interface GeoGridRunDeps {
  geogrid: GeoGridRepo;
  providers: Record<GeoGridProviderName, GeoGridProvider>;
  appUrl: string;
}

export async function runGeoGrid(
  deps: GeoGridRunDeps, jobId: string, configId: string, keyword: string,
): Promise<{ awaiting: boolean }> {
  const config = await deps.geogrid.getConfig(configId);
  if (!config) throw new Error(`GeoGrid config not found: ${configId}`);

  const provider = deps.providers[config.provider];
  if (!provider) throw new Error(`Unknown GeoGrid provider: ${config.provider}`);

  const points = buildGrid(config.center_lat, config.center_lng, config.grid_size, config.spacing_m);
  const outcome = await provider.run({
    runId: jobId,
    keyword,
    businessName: config.business_name,
    placeRef: config.place_ref,
    points,
    callbackUrl: `${deps.appUrl.replace(/\/+$/, "")}/api/webhooks/n8n/geogrid`,
  });

  if (outcome.kind === "ranks") {
    await deps.geogrid.insertSnapshot(configId, keyword, outcome.ranks);
    return { awaiting: false };
  }
  return { awaiting: true };
}

export async function completeGeoGridRun(
  repo: GeoGridRepo, configId: string, keyword: string, ranks: RankPoint[],
): Promise<void> {
  await repo.insertSnapshot(configId, keyword, ranks);
}
```

- [ ] **Step 5: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors (the `processJobs` return type change ripples into the cron route's JSON — it spreads the result, so no edit needed).

```powershell
git add src/services/jobs src/services/geogrid/run.ts tests/geogrid-run.test.ts; git commit -m "feat: awaiting-callback jobs and geogrid run orchestrator"
```

---

### Task 5: Callback route + handler + watchdog (TDD on signature)

**Files:**
- Create: `src/lib/n8n-auth.ts`, `src/app/api/webhooks/n8n/geogrid/route.ts`
- Modify: `src/services/jobs/handlers.ts`, `src/app/api/cron/process/route.ts`
- Test: `tests/geogrid-callback.test.ts`

**Interfaces:**
- Produces:
```ts
// n8n-auth.ts
export function verifyN8nRequest(rawBody: string, headers: Headers): boolean;
// true when x-n8n-signature is a valid HMAC-SHA256 hex of rawBody (with or without "sha256=" prefix)
// OR x-n8n-secret timing-safe equals N8N_WEBHOOK_SECRET. false when the secret is unset.

// POST /api/webhooks/n8n/geogrid
// body: { run_id: string, ranks: Array<{ idx: number, rank: number | null }>, error?: string }
// 401 unauthorized · 400 malformed · 404 unknown/not-awaiting run · 200 { ok: true }
// on error field: marks the job failed with that message
```
Handler `geogrid_run`: payload `{ config_id, keyword }`; calls `runGeoGrid`; returns `{ awaitingCallback: true }` when it parks.

- [ ] **Step 1: Write the failing tests**

`tests/geogrid-callback.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyN8nRequest } from "@/lib/n8n-auth";

afterEach(() => { delete process.env.N8N_WEBHOOK_SECRET; });

const BODY = JSON.stringify({ run_id: "abc", ranks: [] });

describe("verifyN8nRequest", () => {
  it("accepts a valid HMAC signature, with or without the sha256 prefix", () => {
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    const sig = createHmac("sha256", "s3cret").update(BODY).digest("hex");
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-signature": sig }))).toBe(true);
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-signature": `sha256=${sig}` }))).toBe(true);
  });

  it("rejects a signature computed over different content", () => {
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    const sig = createHmac("sha256", "s3cret").update("other").digest("hex");
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-signature": sig }))).toBe(false);
  });

  it("accepts the shared-secret header", () => {
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-secret": "s3cret" }))).toBe(true);
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-secret": "wrong" }))).toBe(false);
  });

  it("fails closed when no secret is configured or no auth header is sent", () => {
    expect(verifyN8nRequest(BODY, new Headers({ "x-n8n-secret": "anything" }))).toBe(false);
    process.env.N8N_WEBHOOK_SECRET = "s3cret";
    expect(verifyN8nRequest(BODY, new Headers())).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/geogrid-callback.test.ts` → FAIL.

- [ ] **Step 3: Implement the auth helper**

`src/lib/n8n-auth.ts`:
```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { getOptionalEnv } from "@/lib/env";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Either proof of the shared secret is accepted: an HMAC over the raw body
 * (preferred) or the secret itself in a header (one field to configure in n8n).
 */
export function verifyN8nRequest(rawBody: string, headers: Headers): boolean {
  const secret = getOptionalEnv("N8N_WEBHOOK_SECRET");
  if (!secret) return false;

  const signature = headers.get("x-n8n-signature");
  if (signature) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqual(signature.replace(/^sha256=/i, "").trim().toLowerCase(), expected);
  }
  const bearer = headers.get("x-n8n-secret");
  return bearer !== null && safeEqual(bearer, secret);
}
```

- [ ] **Step 4: Implement the callback route**

`src/app/api/webhooks/n8n/geogrid/route.ts`:
```ts
import { NextResponse } from "next/server";
import { verifyN8nRequest } from "@/lib/n8n-auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { completeGeoGridRun } from "@/services/geogrid/run";
import { buildGrid } from "@/services/geogrid/grid";
import type { RankPoint } from "@/services/geogrid/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface CallbackBody {
  run_id?: unknown;
  ranks?: unknown;
  error?: unknown;
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyN8nRequest(raw, req.headers)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: CallbackBody;
  try {
    body = JSON.parse(raw) as CallbackBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const runId = typeof body.run_id === "string" ? body.run_id : null;
  if (!runId) return NextResponse.json({ ok: false, error: "run_id required" }, { status: 400 });

  const db = createServiceSupabase();
  const jobs = supabaseJobsRepo(db);
  const job = await jobs.getJob(runId);
  if (!job || job.type !== "geogrid_run" || job.status !== "awaiting_callback") {
    return NextResponse.json({ ok: false, error: "no run awaiting this id" }, { status: 404 });
  }

  if (typeof body.error === "string" && body.error) {
    await jobs.markFailed(runId, `n8n reported: ${body.error}`);
    return NextResponse.json({ ok: true, recorded: "error" });
  }

  const payload = job.payload as { config_id?: string; keyword?: string };
  if (!payload.config_id || !payload.keyword) {
    await jobs.markFailed(runId, "job payload malformed");
    return NextResponse.json({ ok: false, error: "job payload malformed" }, { status: 400 });
  }

  const geogrid = supabaseGeoGridRepo(db);
  const config = await geogrid.getConfig(payload.config_id);
  if (!config) {
    await jobs.markFailed(runId, "GeoGrid config no longer exists");
    return NextResponse.json({ ok: false, error: "config missing" }, { status: 404 });
  }

  // Coordinates come from our own config, not from the callback: n8n only
  // reports a rank per point index, so a hostile body cannot move the grid.
  const grid = buildGrid(config.center_lat, config.center_lng, config.grid_size, config.spacing_m);
  const byIdx = new Map<number, number | null>();
  for (const entry of Array.isArray(body.ranks) ? body.ranks : []) {
    const e = entry as { idx?: unknown; rank?: unknown };
    if (typeof e.idx !== "number") continue;
    const rank = typeof e.rank === "number" && e.rank >= 1 && e.rank <= 20 ? Math.round(e.rank) : null;
    byIdx.set(e.idx, rank);
  }
  const ranks: RankPoint[] = grid.map((p) => ({ ...p, rank: byIdx.get(p.idx) ?? null }));

  await completeGeoGridRun(geogrid, payload.config_id, payload.keyword, ranks);
  await jobs.markDone(runId);
  return NextResponse.json({ ok: true, points: ranks.length });
}
```

- [ ] **Step 5: Wire the handler and watchdog**

`src/services/jobs/handlers.ts` — add imports and the handler:
```ts
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { runGeoGrid } from "@/services/geogrid/run";
import { stubProvider } from "@/services/geogrid/providers/stub";
import { createN8nProvider } from "@/services/geogrid/providers/n8n";
import { getOptionalEnv } from "@/lib/env";
```
and inside `buildJobHandlers`, in the returned object:
```ts
    geogrid_run: async ({ job }) => {
      const p = job.payload as { config_id?: string; keyword?: string };
      if (!p?.config_id || !p?.keyword) throw new Error("geogrid_run payload malformed");
      const { awaiting } = await runGeoGrid(
        {
          geogrid: supabaseGeoGridRepo(db),
          providers: { stub: stubProvider, n8n: createN8nProvider() },
          appUrl: getOptionalEnv("APP_URL") ?? "http://localhost:3000",
        },
        job.id, p.config_id, p.keyword,
      );
      if (awaiting) return { awaitingCallback: true };
    },
```

`src/app/api/cron/process/route.ts` — before claiming jobs, add the watchdog:
```ts
  const jobsRepo = supabaseJobsRepo(db);
  // Runs parked waiting on an n8n callback that never arrived are failed so
  // their normal retry/backoff can take over.
  const stale = await jobsRepo.failStaleAwaiting(30 * 60 * 1000);
  const result = await processJobs(jobsRepo, buildJobHandlers(db), { max: 3 });
  return NextResponse.json({ ok: true, stale, ...result });
```
(Replace the existing `processJobs(...)`/return lines; keep the auth guard, `dynamic`, and `maxDuration`.)

- [ ] **Step 6: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors; `npm run build` → success.

```powershell
git add src/lib/n8n-auth.ts src/app/api src/services/jobs/handlers.ts tests/geogrid-callback.test.ts; git commit -m "feat: signed n8n geogrid callback, job handler, and stale-run watchdog"
```

---

### Task 6: GeoGrid actions + config form

**Files:**
- Create: `src/app/(dashboard)/sites/[id]/geogrid-actions.ts`, `src/app/(dashboard)/sites/[id]/geogrid/config-form.tsx`

**Interfaces:**
- Consumes: `supabaseGeoGridRepo`, `enqueueBatch`/`enqueueJob`, `requireUser`, `supabaseSitesRepo`.
- Produces:
```ts
// geogrid-actions.ts ("use server")
export async function saveGeoGridConfigAction(siteId: string, formData: FormData): Promise<{ ok: boolean; error?: string }>;
export async function runGeoGridAction(siteId: string): Promise<{ ok: boolean; error?: string; queued?: number }>;
// config-form.tsx (client): <GeoGridConfigForm siteId config />
```
`saveGeoGridConfigAction` parses and validates: business name required; keywords comma-separated, 1..10, trimmed, deduped; grid_size ∈ {3,5,7,9}; spacing 100..20000; lat −90..90; lng −180..180; provider ∈ {stub,n8n}. Logs `site.geogrid_config`.
`runGeoGridAction` enqueues one `geogrid_run` job per keyword sharing a `batch_id`, logs `site.geogrid_run`, revalidates the page.

- [ ] **Step 1: Implement the actions**

`src/app/(dashboard)/sites/[id]/geogrid-actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import type { GeoGridProviderName } from "@/services/geogrid/types";
import { enqueueBatch } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

const SIZES = new Set([3, 5, 7, 9]);

export async function saveGeoGridConfigAction(
  siteId: string, formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const businessName = String(formData.get("business_name") ?? "").trim();
  const placeRefRaw = String(formData.get("place_ref") ?? "").trim();
  const keywords = [...new Set(
    String(formData.get("keywords") ?? "").split(",").map((k) => k.trim()).filter(Boolean),
  )];
  const gridSize = Number(formData.get("grid_size"));
  const spacing = Number(formData.get("spacing_m"));
  const lat = Number(formData.get("center_lat"));
  const lng = Number(formData.get("center_lng"));
  const provider = String(formData.get("provider") ?? "stub") as GeoGridProviderName;

  if (!businessName) return { ok: false, error: "Business name is required" };
  if (keywords.length === 0) return { ok: false, error: "Add at least one keyword" };
  if (keywords.length > 10) return { ok: false, error: "Ten keywords maximum" };
  if (!SIZES.has(gridSize)) return { ok: false, error: "Grid size must be 3, 5, 7 or 9" };
  if (!Number.isFinite(spacing) || spacing < 100 || spacing > 20_000) {
    return { ok: false, error: "Spacing must be between 100 and 20000 metres" };
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: "Latitude must be between -90 and 90" };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: "Longitude must be between -180 and 180" };
  if (provider !== "stub" && provider !== "n8n") return { ok: false, error: "Unknown provider" };

  const db = createServiceSupabase();
  try {
    await supabaseGeoGridRepo(db).upsertConfig(siteId, {
      business_name: businessName,
      place_ref: placeRefRaw || null,
      keywords,
      grid_size: gridSize,
      spacing_m: Math.round(spacing),
      center_lat: lat,
      center_lng: lng,
      provider,
    });
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.geogrid_config",
      detail: { keywords: keywords.length, grid_size: gridSize, provider },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save configuration" };
  }
  revalidatePath(`/sites/${siteId}/geogrid`);
  return { ok: true };
}

export async function runGeoGridAction(
  siteId: string,
): Promise<{ ok: boolean; error?: string; queued?: number }> {
  const user = await requireUser();
  const db = createServiceSupabase();
  const config = await supabaseGeoGridRepo(db).getConfigBySite(siteId);
  if (!config) return { ok: false, error: "Save a GeoGrid configuration first" };
  if (config.keywords.length === 0) return { ok: false, error: "Add at least one keyword" };

  try {
    const jobs = supabaseJobsRepo(db);
    const batchId = crypto.randomUUID();
    for (const keyword of config.keywords) {
      await jobs.insert({
        type: "geogrid_run", site_id: siteId, batch_id: batchId,
        payload: { config_id: config.id, keyword },
      });
    }
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.geogrid_run",
      detail: { keywords: config.keywords.length, provider: config.provider },
    });
    revalidatePath(`/sites/${siteId}/geogrid`);
    return { ok: true, queued: config.keywords.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not queue the run" };
  }
}
```
(Note: `enqueueBatch` is not used here because each job needs a distinct payload; `jobs.insert` with a shared `batch_id` is the same mechanism.)

- [ ] **Step 2: Implement the config form**

`src/app/(dashboard)/sites/[id]/geogrid/config-form.tsx`:
```tsx
"use client";

import { useActionState } from "react";
import { saveGeoGridConfigAction } from "../geogrid-actions";
import type { GeoGridConfig } from "@/services/geogrid/types";

const field = "min-h-10 w-full rounded border px-3 py-2";

export function GeoGridConfigForm({
  siteId, config,
}: { siteId: string; config: GeoGridConfig | null }) {
  const action = saveGeoGridConfigAction.bind(null, siteId) as unknown as (
    prev: { ok: boolean; error?: string } | null, formData: FormData,
  ) => Promise<{ ok: boolean; error?: string }>;
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="space-y-4 rounded-lg border bg-white p-4 shadow-sm">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Business name
          <input name="business_name" required defaultValue={config?.business_name ?? ""}
            placeholder="Test Cafe" className={field} />
        </label>
        <label className="block text-sm font-medium">
          Place reference (optional)
          <input name="place_ref" defaultValue={config?.place_ref ?? ""}
            placeholder="Google place id or listing URL" className={field} />
        </label>
      </div>

      <label className="block text-sm font-medium">
        Keywords (comma separated, up to 10)
        <input name="keywords" required defaultValue={config?.keywords.join(", ") ?? ""}
          placeholder="coffee shop, espresso bar" className={field} />
      </label>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <label className="block text-sm font-medium">
          Grid size
          <select name="grid_size" defaultValue={String(config?.grid_size ?? 5)} className={field}>
            {[3, 5, 7, 9].map((n) => <option key={n} value={n}>{n} × {n}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Spacing (m)
          <input name="spacing_m" type="number" min={100} max={20000} step={100}
            defaultValue={config?.spacing_m ?? 1000} className={field} />
        </label>
        <label className="block text-sm font-medium">
          Centre latitude
          <input name="center_lat" type="number" step="any" required
            defaultValue={config?.center_lat ?? ""} placeholder="14.5995" className={field} />
        </label>
        <label className="block text-sm font-medium">
          Centre longitude
          <input name="center_lng" type="number" step="any" required
            defaultValue={config?.center_lng ?? ""} placeholder="120.9842" className={field} />
        </label>
      </div>

      <label className="block text-sm font-medium sm:max-w-64">
        Rank provider
        <select name="provider" defaultValue={config?.provider ?? "stub"} className={field}>
          <option value="stub">Stub (sample data, no API cost)</option>
          <option value="n8n">n8n workflow (live ranks)</option>
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending}
          className="min-h-10 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
          {pending ? "Saving…" : config ? "Update configuration" : "Save configuration"}
        </button>
        <p aria-live="polite" className="text-sm">
          {state && !state.ok && <span className="text-red-600">{state.error}</span>}
          {state?.ok && <span className="text-green-700">Saved.</span>}
        </p>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — green.

```powershell
git add "src/app/(dashboard)/sites/[id]/geogrid-actions.ts" "src/app/(dashboard)/sites/[id]/geogrid"; git commit -m "feat: geogrid configuration form and run actions"
```

---

### Task 7: Map + results page + tab

**Files:**
- Create: `src/app/(dashboard)/sites/[id]/geogrid/grid-map.tsx`, `src/app/(dashboard)/sites/[id]/geogrid/page.tsx`
- Modify: `src/app/(dashboard)/sites/[id]/tabs.tsx`, `package.json` (leaflet deps)

**Interfaces:**
- Consumes: `supabaseGeoGridRepo`, `averageRank`/`coverage`, `runGeoGridAction`, `ManageForm`, `GeoGridConfigForm`.
- Produces: route `/sites/[id]/geogrid`; `GridMap({ points, center, businessName })` client component.

- [ ] **Step 1: Install Leaflet**

```powershell
npm install leaflet@1.9.4; npm install -D @types/leaflet
```

- [ ] **Step 2: Implement the map component**

`src/app/(dashboard)/sites/[id]/geogrid/grid-map.tsx`:
```tsx
"use client";

import { useEffect, useRef } from "react";
import type { RankPoint } from "@/services/geogrid/types";

function colourFor(rank: number | null): string {
  if (rank === null) return "#dc2626";      // not found
  if (rank <= 3) return "#16a34a";
  if (rank <= 7) return "#65a30d";
  if (rank <= 10) return "#ca8a04";
  if (rank <= 15) return "#ea580c";
  return "#dc2626";
}

export function GridMap({
  points, center, businessName,
}: { points: RankPoint[]; center: { lat: number; lng: number }; businessName: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current || points.length === 0) return;
    let cancelled = false;
    let map: import("leaflet").Map | null = null;

    // Leaflet touches window on import, so it loads only in the browser.
    void (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      if (cancelled || !ref.current) return;

      map = L.map(ref.current, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      for (const p of points) {
        const label = p.rank === null ? "20+" : String(p.rank);
        L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: "",
            html: `<div style="background:${colourFor(p.rank)};color:#fff;border-radius:9999px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font:600 12px system-ui;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">${label}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        }).addTo(map).bindPopup(`${businessName}<br>Rank: ${label}`);
      }

      L.circleMarker([center.lat, center.lng], {
        radius: 4, color: "#0f172a", weight: 2, fillOpacity: 1,
      }).addTo(map).bindPopup("Grid centre");

      map.fitBounds(points.map((p) => [p.lat, p.lng] as [number, number]), { padding: [24, 24] });
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [points, center.lat, center.lng, businessName]);

  if (points.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center rounded-lg border border-dashed bg-white text-sm text-slate-500">
        No results yet — run a scan to plot the grid.
      </div>
    );
  }
  return <div ref={ref} className="h-80 w-full rounded-lg border sm:h-96" role="application"
    aria-label="GeoGrid rank map" />;
}
```

- [ ] **Step 3: Implement the page**

`src/app/(dashboard)/sites/[id]/geogrid/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { averageRank, coverage } from "@/services/geogrid/types";
import { SiteTabs } from "../tabs";
import { ManageForm, type ManageFormAction } from "../action-form";
import { runGeoGridAction } from "../geogrid-actions";
import { GeoGridConfigForm } from "./config-form";
import { GridMap } from "./grid-map";

export const dynamic = "force-dynamic";

export default async function GeoGridPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ k?: string }> }) {
  const { id } = await params;
  const { k } = await searchParams;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();

  const geogrid = supabaseGeoGridRepo(db);
  const config = await geogrid.getConfigBySite(id);
  const latest = config ? await geogrid.latestPerKeyword(config.id) : {};
  const keyword = k && config?.keywords.includes(k) ? k : config?.keywords[0];
  const current = keyword ? latest[keyword] : undefined;
  const history = config && keyword ? await geogrid.historyForKeyword(config.id, keyword, 10) : [];

  const run = runGeoGridAction.bind(null, id) as unknown as ManageFormAction;
  const avg = current ? averageRank(current.points) : null;
  const cov = current ? coverage(current.points) : 0;
  const previous = history[1];
  const prevAvg = previous ? averageRank(previous.points) : null;
  const delta = avg !== null && prevAvg !== null ? Math.round((prevAvg - avg) * 10) / 10 : null;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">GeoGrid — local rank by location</p>
      <SiteTabs siteId={id} active="geogrid" />

      {config && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {config.keywords.map((kw) => (
                <a key={kw} href={`/sites/${id}/geogrid?k=${encodeURIComponent(kw)}`}
                  aria-current={kw === keyword ? "page" : undefined}
                  className={`min-h-10 rounded-full border px-3 py-2 text-sm ${
                    kw === keyword ? "border-slate-900 bg-slate-900 text-white" : "hover:bg-slate-100"}`}>
                  {kw}
                </a>
              ))}
            </div>
            <ManageForm action={run} label={`Run scan (${config.keywords.length} keyword(s))`}
              pendingLabel="Queueing…"
              confirmMessage={`Queue a GeoGrid scan for ${config.keywords.length} keyword(s) using the ${config.provider} provider?`}
              buttonClassName="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" />
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Average rank", value: avg === null ? "—" : String(avg) },
              { label: "Coverage", value: `${cov}%` },
              { label: "Grid", value: `${config.grid_size}×${config.grid_size} · ${config.spacing_m}m` },
              { label: "Change vs previous", value: delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta}` },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border bg-white p-3 text-center shadow-sm">
                <p className="text-lg font-semibold">{s.value}</p>
                <p className="text-xs text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>

          <div className="mb-6">
            <GridMap points={current?.points ?? []}
              center={{ lat: config.center_lat, lng: config.center_lng }}
              businessName={config.business_name} />
            {current && (
              <p className="mt-2 text-xs text-slate-500">
                {keyword} · scanned {new Date(current.run_at).toLocaleString()} · green = top 3, red = not in the top 20
              </p>
            )}
            {!current && config.keywords.length > 0 && (
              <p className="mt-2 text-xs text-slate-500">
                No results stored for this keyword yet. Runs are queued as jobs — the queue processes
                every minute, or use “Process queue now” on a batch page.
              </p>
            )}
          </div>

          {history.length > 1 && (
            <section className="mb-6 rounded-lg border bg-white shadow-sm">
              <h2 className="border-b px-4 py-3 font-medium">Run history — {keyword}</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-2">Run</th>
                      <th className="px-4 py-2">Average rank</th>
                      <th className="px-4 py-2">Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((snap) => (
                      <tr key={snap.id} className="border-b last:border-0">
                        <td className="px-4 py-2">{new Date(snap.run_at).toLocaleString()}</td>
                        <td className="px-4 py-2">{averageRank(snap.points) ?? "—"}</td>
                        <td className="px-4 py-2">{coverage(snap.points)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      <section>
        <h2 className="mb-2 font-medium">{config ? "Configuration" : "Set up GeoGrid"}</h2>
        {!config && (
          <p className="mb-3 text-sm text-slate-500">
            Enter the business, the keywords to track, and the centre of the area to measure.
            Start with the stub provider to see how the grid looks; switch to n8n for live ranks.
          </p>
        )}
        <GeoGridConfigForm siteId={id} config={config} />
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Flip the tab live**

In `src/app/(dashboard)/sites/[id]/tabs.tsx`:
```ts
const LIVE = [
  { key: "overview", label: "Overview", href: (id: string) => `/sites/${id}` },
  { key: "plugins", label: "Plugins", href: (id: string) => `/sites/${id}/plugins` },
  { key: "themes", label: "Themes", href: (id: string) => `/sites/${id}/themes` },
  { key: "security", label: "Security", href: (id: string) => `/sites/${id}/security` },
  { key: "seo", label: "SEO", href: (id: string) => `/sites/${id}/seo` },
  { key: "geogrid", label: "GeoGrid", href: (id: string) => `/sites/${id}/geogrid` },
] as const;
const COMING = ["Reports"];
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — green.

```powershell
git add package.json package-lock.json "src/app/(dashboard)"; git commit -m "feat: geogrid map, results page, and live tab"
```

---

### Task 8: n8n workflow + docs

**Files:**
- Create: `docs/ops/n8n-geogrid-workflow.json`, `docs/ops/geogrid.md`
- Modify: `README.md`

**Interfaces:** none (documentation and an importable workflow).

- [ ] **Step 1: Write the importable workflow**

`docs/ops/n8n-geogrid-workflow.json`:
```json
{
  "name": "WP Control Panel — GeoGrid",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "wp-panel-geogrid",
        "responseMode": "onReceived",
        "options": {}
      },
      "id": "webhook",
      "name": "GeoGrid request",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 0]
    },
    {
      "parameters": {
        "fieldToSplitOut": "body.points",
        "options": {}
      },
      "id": "split",
      "name": "One item per grid point",
      "type": "n8n-nodes-base.splitOut",
      "typeVersion": 1,
      "position": [220, 0]
    },
    {
      "parameters": {
        "jsCode": "// Replace this node with a real rank lookup (DataForSEO, SerpApi, ...).\n// It must output { idx, rank } per item; rank is 1-20 or null.\nreturn $input.all().map((item) => ({\n  json: { idx: item.json.idx, rank: null },\n}));"
      },
      "id": "lookup",
      "name": "Rank lookup (replace me)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [440, 0]
    },
    {
      "parameters": {
        "mode": "combine",
        "combineBy": "combineAll",
        "options": {}
      },
      "id": "aggregate",
      "name": "Collect ranks",
      "type": "n8n-nodes-base.aggregate",
      "typeVersion": 1,
      "position": [660, 0]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "={{ $('GeoGrid request').first().json.body.callback_url }}",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            { "name": "x-n8n-secret", "value": "={{ $env.WP_PANEL_SECRET }}" }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ run_id: $('GeoGrid request').first().json.body.run_id, ranks: $json.data }) }}",
        "options": {}
      },
      "id": "callback",
      "name": "Post ranks back",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [880, 0]
    }
  ],
  "connections": {
    "GeoGrid request": { "main": [[{ "node": "One item per grid point", "type": "main", "index": 0 }]] },
    "One item per grid point": { "main": [[{ "node": "Rank lookup (replace me)", "type": "main", "index": 0 }]] },
    "Rank lookup (replace me)": { "main": [[{ "node": "Collect ranks", "type": "main", "index": 0 }]] },
    "Collect ranks": { "main": [[{ "node": "Post ranks back", "type": "main", "index": 0 }]] }
  },
  "settings": {},
  "pinData": {}
}
```

- [ ] **Step 2: Write the setup guide**

`docs/ops/geogrid.md`:
```markdown
# GeoGrid setup

GeoGrid measures where a business ranks in Google's local pack across a grid of
coordinates. The panel owns the grid and the storage; a **provider** supplies the
rank at each point.

## Providers

- **stub** — deterministic sample ranks, no API cost, no configuration. Use it to
  see the map and validate the workflow end to end.
- **n8n** — the panel POSTs the grid to your n8n workflow, which looks up real
  ranks and posts them back.

Pick the provider per site in the GeoGrid tab's configuration form.

## Wiring the n8n provider

1. Import `docs/ops/n8n-geogrid-workflow.json` into n8n (Workflows → Import from file).
2. Replace the **Rank lookup (replace me)** node with a real lookup (DataForSEO
   `serp/google/maps/live/advanced`, SerpApi, etc.). It receives one item per grid
   point with `idx`, `lat`, `lng`, and must output `{ idx, rank }` where `rank` is
   1-20 or `null` when the business is not in the local pack.
3. Set an n8n environment variable `WP_PANEL_SECRET` to the same value you use for
   `N8N_WEBHOOK_SECRET` below.
4. Activate the workflow and copy its production webhook URL.
5. Set these in the panel's environment (`.env.local` locally, project settings on
   Vercel):

```
APP_URL=https://your-panel-domain
N8N_GEOGRID_WEBHOOK_URL=https://your-n8n/webhook/wp-panel-geogrid
N8N_WEBHOOK_SECRET=<a long random string>
```

## The contract

The panel sends:

```json
{
  "run_id": "<job uuid>",
  "keyword": "coffee shop",
  "business": { "name": "Test Cafe", "place_ref": null },
  "points": [{ "idx": 0, "lat": 14.61, "lng": 120.97 }],
  "callback_url": "https://your-panel-domain/api/webhooks/n8n/geogrid"
}
```

Your workflow replies (any time within 30 minutes):

```json
{ "run_id": "<same uuid>", "ranks": [{ "idx": 0, "rank": 4 }] }
```

Or reports a failure, which fails the job with your message:

```json
{ "run_id": "<same uuid>", "error": "SERP provider quota exceeded" }
```

Authentication: send either `x-n8n-secret: <N8N_WEBHOOK_SECRET>` (simplest) or
`x-n8n-signature: <hex HMAC-SHA256 of the raw body using the secret>`.

Only `idx` and `rank` are read from the callback — coordinates always come from the
panel's stored configuration, so a bad payload cannot move the grid. Runs that never
call back are failed automatically after 30 minutes and retried per the normal job
backoff.
```

- [ ] **Step 3: README**

In `README.md`, add after the "SEO & AEO" section:
```markdown
## GeoGrid

The GeoGrid tab tracks local-pack rank across an N×N grid of coordinates around a
business, plotted on a map with per-point ranks and run-over-run comparison. Ranks
come from a provider: the built-in **stub** (sample data, no setup) or your **n8n**
workflow for live results — see `docs/ops/geogrid.md`.
```

- [ ] **Step 4: Commit**

```powershell
git add docs/ops README.md; git commit -m "docs: geogrid setup guide and importable n8n workflow"
```

---

## Self-Review Notes

- **Spec §6.7 coverage:** per-site config (business, keywords, 3–9 grid, spacing, centre, provider) in T2/T6; provider adapter with stub + n8n in T1/T3; job-per-keyword runs with `awaiting_callback` parking and a 30-minute watchdog in T4/T5; HMAC-signed callback (plus the documented shared-secret alternative) in T5; Leaflet map with rank-coloured pins, keyword switcher, and run-history deltas in T7; importable n8n workflow and setup guide in T8.
- **Type consistency:** `GeoGridProvider`/`ProviderRequest`/`ProviderOutcome` defined once (T1) and implemented by both providers (T3), consumed by `runGeoGrid` (T4); `RankPoint` flows from providers through the repo (T2) to the map (T7); `JobHandler`'s widened return type (T4) is what the `geogrid_run` handler uses (T5).
- **Judgment calls:** the callback trusts only `idx`/`rank` and rebuilds coordinates locally, so a forged payload cannot relocate the grid; plain `leaflet` instead of `react-leaflet` avoids React-version coupling for ~30 lines of `useEffect`; one config per site (the schema permits many, but the UI and repo treat it as one, which matches how the team works and keeps the page simple).
