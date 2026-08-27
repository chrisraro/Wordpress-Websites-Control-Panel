# Phase 3: Security Analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every site gets an A–F security grade backed by four evidence streams: known-vulnerability matching (Wordfence v3 feed), a 14-point hardening audit, core file checksum verification, and uptime/SSL monitoring — all visible on a new Security tab and as dashboard badges.

**Architecture:** A nightly global `vuln_feed_refresh` job caches the Wordfence Intelligence scanner feed into the `vuln_feed` table; per-site `security_scan` jobs match the latest inventory snapshot against the cache, run a hardening audit (one `execute-php` snippet + HTTP probes from our server), verify core checksums against the wordpress.org API (inside WordPress via `wp_remote_get` + `md5_file` — WP-CLI is unusable on this host per spec §3.1), and store graded results in `security_checks`/`site_vulnerabilities`. A 5-minute `pg_cron` job hits `/api/cron/uptime` for HTTP + TLS-expiry checks. All WordPress access via `runPhp` (`src/lib/wpphp.ts`).

**Tech Stack:** Existing stack. No new dependencies (TLS inspection via `node:tls`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md` §6.2 + §3.1 amendment. **Never use `novamira/run-wp-cli`** — all WordPress work goes through `runPhp` from `@/lib/wpphp` (PHP snippets return `json_encode(...)`; untrusted values embedded only via `phpString`). This fleet runs PHP 8.x.
- Wordfence feed: v2 is removed (410, verified). Use v3 scanner feed `https://www.wordfence.com/api/intelligence/v3/vulnerabilities/scanner` with `Authorization: Bearer <WORDFENCE_API_KEY>`. The key is OPTIONAL env — without it, vulnerability matching is skipped and the scan records a `wordfence_feed` warn check telling the user to add the key. Nothing may crash on a missing key.
- Grading weights (exact): start at 100; per vulnerability critical −30, high −20, medium −10, low/unknown −5; hardening check fail −5 (except `core_checksums` fail −15), warn −2; 24h uptime < 99% −5 (only when uptime data exists). Clamp to ≥ 0. Bands: A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50, else F. Severity from CVSS: ≥ 9 critical, ≥ 7 high, ≥ 4 medium, > 0 low, null/0 unknown (`null` severity).
- Job rules unchanged (idempotent, max 3 attempts, 60s/300s backoff, dedupe). New `JobType` values: `security_scan` (per site), `vuln_feed_refresh` (global, `site_id` null).
- Cron routes stay `CRON_SECRET`-gated via `isAuthorizedCronRequest`. Uptime route budget: `maxDuration = 60`, per-site HTTP timeout 15s.
- Every mutating UI action: confirm dialog (ManageForm) + activity log. Scan-triggered writes are job/system writes and are NOT activity-logged.
- Responsive mandatory (tables in `overflow-x-auto`, tap targets ≥ 40px via `min-h-10`, flex-wrap rows). Impeccable audit runs after the UI task (orchestrator-level).
- MCP clients per call, `close()` in `finally`, PHP snippet timeouts: hardening 60s, checksums 180s.
- Scan failure handling per spec §8: 3 consecutive scan failures → site status `degraded` (sites.consecutive_failures column exists); success resets the counter and restores `connected` (only when current status is `degraded`).
- Commit after every task; PowerShell-safe commands.

## File Structure (new/changed)

```
src/lib/env.ts                          # + getOptionalEnv
src/lib/version.ts                      # compareVersions, versionInRange
src/lib/adapters/vulnfeed/wordfence.ts  # parseWordfenceFeed, fetchWordfenceFeed
src/services/security/types.ts          # SecurityCheck, UptimeRow, Grade, computeGrade, severityFromCvss
src/services/security/vulns.ts          # matchInventory
src/services/security/repo.ts           # SecurityRepo + supabaseSecurityRepo
src/services/security/hardening.ts      # HARDENING_PHP, runPhpHardening, runHttpHardening
src/services/security/checksums.ts      # CHECKSUMS_PHP, runChecksums
src/services/security/uptime.ts         # checkSite, sslDaysRemaining
src/services/security/scan.ts           # securityScan orchestrator + refreshVulnFeed
src/services/jobs/types.ts              # JobType union extended
src/app/api/cron/process/route.ts       # + security_scan, vuln_feed_refresh handlers
src/app/api/cron/enqueue/route.ts       # + per-site security_scan, global vuln_feed_refresh
src/app/api/cron/uptime/route.ts        # new
src/app/(dashboard)/sites/[id]/security-actions.ts  # runSecurityScanAction
src/app/(dashboard)/sites/[id]/security/page.tsx    # Security tab
src/app/(dashboard)/sites/[id]/tabs.tsx # Security moves from COMING to LIVE
src/app/(dashboard)/dashboard/page.tsx  # grade chips
docs/ops/scheduling.md, README.md, .env.example
tests/{version,wordfence,grading,hardening,checksums,scan,uptime}.test.ts
```

---

### Task 1: Optional env accessor + version comparison (TDD)

**Files:**
- Modify: `src/lib/env.ts` (append function), `.env.example` (append var)
- Create: `src/lib/version.ts`
- Test: `tests/version.test.ts`

**Interfaces:**
- Produces:
```ts
// env.ts (append; NAMES tuple unchanged)
export function getOptionalEnv(name: string): string | undefined; // empty string -> undefined

// version.ts
export interface VulnRange { from_version: string; from_inclusive: boolean; to_version: string; to_inclusive: boolean }
export function compareVersions(a: string, b: string): number;         // -1 | 0 | 1
export function versionInRange(version: string, range: VulnRange): boolean; // "*" = unbounded side
```

- [ ] **Step 1: Write the failing tests**

`tests/version.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { compareVersions, versionInRange } from "@/lib/version";

describe("compareVersions", () => {
  it("compares numeric segments", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.10")).toBe(-1);
    expect(compareVersions("2.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("6.7.1.2", "6.7.1")).toBe(1);
  });
  it("treats suffixed prereleases as older than the release", () => {
    expect(compareVersions("1.2.3-beta1", "1.2.3")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3-rc1")).toBe(1);
    expect(compareVersions("1.2.3-beta1", "1.2.3-beta2")).toBe(-1);
  });
});

describe("versionInRange", () => {
  const r = (from: string, fi: boolean, to: string, ti: boolean) =>
    ({ from_version: from, from_inclusive: fi, to_version: to, to_inclusive: ti });

  it("handles bounded inclusive/exclusive ranges", () => {
    expect(versionInRange("1.5", r("1.0", true, "2.0", true))).toBe(true);
    expect(versionInRange("2.0", r("1.0", true, "2.0", true))).toBe(true);
    expect(versionInRange("2.0", r("1.0", true, "2.0", false))).toBe(false);
    expect(versionInRange("1.0", r("1.0", false, "2.0", true))).toBe(false);
    expect(versionInRange("0.9", r("1.0", true, "2.0", true))).toBe(false);
  });
  it("handles wildcard bounds (Wordfence uses *)", () => {
    expect(versionInRange("0.1", r("*", true, "5.3.9", true))).toBe(true);
    expect(versionInRange("5.4", r("*", true, "5.3.9", true))).toBe(false);
    expect(versionInRange("99.0", r("2.0", true, "*", true))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/version.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Append to `src/lib/env.ts`:
```ts
export function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v ? v : undefined;
}
```

Append to `.env.example`:
```
# optional: free key from https://www.wordfence.com/threat-intel/ (register, create API key).
# Without it, vulnerability matching is skipped (the rest of the security scan still runs).
WORDFENCE_API_KEY=
```

`src/lib/version.ts`:
```ts
export interface VulnRange {
  from_version: string;
  from_inclusive: boolean;
  to_version: string;
  to_inclusive: boolean;
}

/** Split "1.2.3-beta1" into numeric segments plus an optional suffix. */
function parse(v: string): { nums: number[]; suffix: string } {
  const [main, ...rest] = v.trim().split("-");
  const nums = main.split(".").map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  return { nums, suffix: rest.join("-").toLowerCase() };
}

export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // Same numeric core: a suffix (beta/rc) sorts before the bare release.
  if (pa.suffix && !pb.suffix) return -1;
  if (!pa.suffix && pb.suffix) return 1;
  if (pa.suffix !== pb.suffix) return pa.suffix < pb.suffix ? -1 : 1;
  return 0;
}

export function versionInRange(version: string, range: VulnRange): boolean {
  if (range.from_version !== "*") {
    const c = compareVersions(version, range.from_version);
    if (c < 0 || (c === 0 && !range.from_inclusive)) return false;
  }
  if (range.to_version !== "*") {
    const c = compareVersions(version, range.to_version);
    if (c > 0 || (c === 0 && !range.to_inclusive)) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test` → full suite green (46 existing + 7 new).

- [ ] **Step 5: Commit**

```powershell
git add src/lib/env.ts src/lib/version.ts .env.example tests/version.test.ts; git commit -m "feat: version-range comparison and optional env accessor"
```

---

### Task 2: Wordfence v3 feed adapter (TDD on parsing)

**Files:**
- Create: `src/lib/adapters/vulnfeed/wordfence.ts`
- Test: `tests/wordfence.test.ts`

**Interfaces:**
- Consumes: `VulnRange` (Task 1).
- Produces:
```ts
export interface FeedEntry {
  id: string;                                  // `${vulnUuid}:${type}:${slug}` (one row per affected software)
  title: string;
  cve: string | null;
  cvss: number | null;
  software_type: "plugin" | "theme" | "core";
  software_slug: string;                        // for core, slug is "wordpress"
  affected_versions: VulnRange[];
  fixed_in: string | null;                      // first patched version if any
}
export const WORDFENCE_SCANNER_URL = "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/scanner";
export function parseWordfenceFeed(raw: unknown): FeedEntry[];   // tolerant: skips malformed records
export async function fetchWordfenceFeed(apiKey: string, fetchImpl?: typeof fetch): Promise<FeedEntry[]>; // Bearer auth; throws Error with status on non-200
```

- [ ] **Step 1: Write the failing tests**

`tests/wordfence.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseWordfenceFeed, fetchWordfenceFeed } from "@/lib/adapters/vulnfeed/wordfence";

// Shape per Wordfence Intelligence vulnerability feed docs (v2/v3 record format).
const SAMPLE = {
  "11111111-aaaa-bbbb-cccc-000000000001": {
    id: "11111111-aaaa-bbbb-cccc-000000000001",
    title: "Akismet < 5.4 - XSS",
    software: [
      {
        type: "plugin", slug: "akismet",
        affected_versions: {
          "* - 5.3.9": { from_version: "*", from_inclusive: true, to_version: "5.3.9", to_inclusive: true },
        },
        patched: true, patched_versions: ["5.4"],
      },
    ],
    cvss: { score: 6.4, rating: "Medium" },
    cve: "CVE-2026-0001",
  },
  "11111111-aaaa-bbbb-cccc-000000000002": {
    id: "11111111-aaaa-bbbb-cccc-000000000002",
    title: "WordPress Core - RCE",
    software: [
      {
        type: "core", slug: "wordpress",
        affected_versions: {
          "6.0 - 6.4.2": { from_version: "6.0", from_inclusive: true, to_version: "6.4.2", to_inclusive: true },
        },
        patched: true, patched_versions: ["6.4.3"],
      },
    ],
    cvss: { score: 9.8, rating: "Critical" },
    cve: null,
  },
  "malformed": { id: "malformed" }, // no software array — must be skipped
};

describe("parseWordfenceFeed", () => {
  it("flattens vuln records to one entry per software", () => {
    const entries = parseWordfenceFeed(SAMPLE);
    expect(entries).toHaveLength(2);
    const akismet = entries.find((e) => e.software_slug === "akismet")!;
    expect(akismet).toMatchObject({
      id: "11111111-aaaa-bbbb-cccc-000000000001:plugin:akismet",
      software_type: "plugin", cve: "CVE-2026-0001", cvss: 6.4, fixed_in: "5.4",
    });
    expect(akismet.affected_versions[0]).toMatchObject({ from_version: "*", to_version: "5.3.9" });
    const core = entries.find((e) => e.software_type === "core")!;
    expect(core.cvss).toBe(9.8);
    expect(core.cve).toBeNull();
  });
  it("returns [] for garbage input", () => {
    expect(parseWordfenceFeed(null)).toEqual([]);
    expect(parseWordfenceFeed("nope")).toEqual([]);
  });
});

describe("fetchWordfenceFeed", () => {
  it("sends Bearer auth and parses the body", async () => {
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain("/v3/vulnerabilities/scanner");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as typeof fetch;
    const entries = await fetchWordfenceFeed("test-key", fetchImpl);
    expect(entries).toHaveLength(2);
  });
  it("throws with the HTTP status on auth failure", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(fetchWordfenceFeed("bad", fetchImpl)).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/wordfence.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/adapters/vulnfeed/wordfence.ts`:
```ts
import type { VulnRange } from "@/lib/version";

export interface FeedEntry {
  id: string;
  title: string;
  cve: string | null;
  cvss: number | null;
  software_type: "plugin" | "theme" | "core";
  software_slug: string;
  affected_versions: VulnRange[];
  fixed_in: string | null;
}

export const WORDFENCE_SCANNER_URL =
  "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/scanner";

const TYPES = new Set(["plugin", "theme", "core"]);

export function parseWordfenceFeed(raw: unknown): FeedEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const entries: FeedEntry[] = [];
  for (const [uuid, recRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!recRaw || typeof recRaw !== "object") continue;
    const rec = recRaw as {
      title?: unknown; cve?: unknown; cvss?: { score?: unknown };
      software?: Array<{
        type?: unknown; slug?: unknown;
        affected_versions?: Record<string, Partial<VulnRange>>;
        patched_versions?: unknown[];
      }>;
    };
    if (!Array.isArray(rec.software)) continue;
    for (const sw of rec.software) {
      const type = String(sw?.type ?? "");
      const slug = String(sw?.slug ?? "");
      if (!TYPES.has(type) || !slug) continue;
      const ranges: VulnRange[] = Object.values(sw.affected_versions ?? {})
        .filter((r): r is VulnRange =>
          typeof r?.from_version === "string" && typeof r?.to_version === "string")
        .map((r) => ({
          from_version: r.from_version,
          from_inclusive: r.from_inclusive !== false,
          to_version: r.to_version,
          to_inclusive: r.to_inclusive !== false,
        }));
      if (ranges.length === 0) continue;
      const patched = (sw.patched_versions ?? []).map(String).filter(Boolean);
      const score = rec.cvss && typeof rec.cvss === "object" ? Number((rec.cvss as { score?: unknown }).score) : NaN;
      entries.push({
        id: `${uuid}:${type}:${slug}`,
        title: typeof rec.title === "string" ? rec.title : slug,
        cve: typeof rec.cve === "string" && rec.cve ? rec.cve : null,
        cvss: Number.isFinite(score) ? score : null,
        software_type: type as FeedEntry["software_type"],
        software_slug: slug,
        affected_versions: ranges,
        fixed_in: patched[0] ?? null,
      });
    }
  }
  return entries;
}

export async function fetchWordfenceFeed(
  apiKey: string, fetchImpl: typeof fetch = fetch,
): Promise<FeedEntry[]> {
  const res = await fetchImpl(WORDFENCE_SCANNER_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Wordfence feed request failed: HTTP ${res.status}`);
  return parseWordfenceFeed(await res.json());
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test` → green.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/adapters tests/wordfence.test.ts; git commit -m "feat: Wordfence v3 scanner feed adapter"
```

---

### Task 3: Security types, grading, and inventory matching (TDD)

**Files:**
- Create: `src/services/security/types.ts`, `src/services/security/vulns.ts`
- Test: `tests/grading.test.ts`

**Interfaces:**
- Consumes: `FeedEntry` (Task 2), `versionInRange` (Task 1), `InventoryPayload` (Phase 2).
- Produces:
```ts
// types.ts
export type CheckResult = "pass" | "fail" | "warn";
export interface SecurityCheck { check_id: string; result: CheckResult; details?: Record<string, unknown> }
export interface UptimeRow { site_id: string; http_status: number | null; response_ms: number | null; ssl_days_remaining: number | null; ok: boolean }
export type Severity = "critical" | "high" | "medium" | "low";
export interface Grade { grade: "A" | "B" | "C" | "D" | "F"; score: number }
export function severityFromCvss(cvss: number | null): Severity | null;
export function computeGrade(input: { vulnSeverities: (Severity | null)[]; checks: SecurityCheck[]; uptime24h: number | null }): Grade;

// vulns.ts
export interface VulnMatch { feed_id: string; component: string; installed_version: string; severity: Severity | null }
export function matchInventory(entries: FeedEntry[], inv: InventoryPayload): VulnMatch[];
// component format: "plugin:<slug>" | "theme:<slug>" | "core"
```

- [ ] **Step 1: Write the failing tests**

`tests/grading.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { computeGrade, severityFromCvss } from "@/services/security/types";
import { matchInventory } from "@/services/security/vulns";
import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import type { InventoryPayload } from "@/services/inventory/types";

describe("severityFromCvss", () => {
  it("maps CVSS bands", () => {
    expect(severityFromCvss(9.8)).toBe("critical");
    expect(severityFromCvss(7.0)).toBe("high");
    expect(severityFromCvss(5.0)).toBe("medium");
    expect(severityFromCvss(2.1)).toBe("low");
    expect(severityFromCvss(0)).toBeNull();
    expect(severityFromCvss(null)).toBeNull();
  });
});

describe("computeGrade", () => {
  it("gives A with a clean slate", () => {
    expect(computeGrade({ vulnSeverities: [], checks: [], uptime24h: 100 }))
      .toEqual({ grade: "A", score: 100 });
  });
  it("applies exact weights", () => {
    const g = computeGrade({
      vulnSeverities: ["critical", "low"],                        // -30 -5
      checks: [
        { check_id: "wp_debug", result: "fail" },                 // -5
        { check_id: "core_checksums", result: "fail" },           // -15
        { check_id: "xmlrpc_enabled", result: "warn" },           // -2
        { check_id: "https_urls", result: "pass" },               // 0
      ],
      uptime24h: 97.5,                                            // -5
    });
    expect(g.score).toBe(100 - 30 - 5 - 5 - 15 - 2 - 5);
    expect(g.grade).toBe("F"); // 38 < 50
  });
  it("clamps at zero and ignores null uptime", () => {
    const g = computeGrade({
      vulnSeverities: Array(5).fill("critical"),
      checks: [],
      uptime24h: null,
    });
    expect(g).toEqual({ grade: "F", score: 0 });
  });
  it("bands correctly", () => {
    expect(computeGrade({ vulnSeverities: [null, null], checks: [], uptime24h: null }).grade).toBe("A"); // 90
    expect(computeGrade({ vulnSeverities: ["medium", "medium"], checks: [], uptime24h: null }).grade).toBe("B"); // 80
    expect(computeGrade({ vulnSeverities: ["high", "medium"], checks: [], uptime24h: null }).grade).toBe("C"); // 70
    expect(computeGrade({ vulnSeverities: ["critical", "high"], checks: [], uptime24h: null }).grade).toBe("D"); // 50
  });
});

const FEED: FeedEntry[] = [
  {
    id: "v1:plugin:akismet", title: "Akismet XSS", cve: null, cvss: 6.4,
    software_type: "plugin", software_slug: "akismet",
    affected_versions: [{ from_version: "*", from_inclusive: true, to_version: "5.3.9", to_inclusive: true }],
    fixed_in: "5.4",
  },
  {
    id: "v2:core:wordpress", title: "Core RCE", cve: null, cvss: 9.8,
    software_type: "core", software_slug: "wordpress",
    affected_versions: [{ from_version: "6.0", from_inclusive: true, to_version: "6.4.2", to_inclusive: true }],
    fixed_in: "6.4.3",
  },
  {
    id: "v3:theme:generatepress", title: "GP LFI", cve: null, cvss: 7.5,
    software_type: "theme", software_slug: "generatepress",
    affected_versions: [{ from_version: "*", from_inclusive: true, to_version: "3.0", to_inclusive: false }],
    fixed_in: "3.0",
  },
];

function inv(over: Partial<InventoryPayload> = {}): InventoryPayload {
  return {
    collected_at: "2026-08-28T00:00:00Z", wp_version: "6.4.1", php_version: "8.2",
    core_update: null, admin_users: [],
    plugins: [{ file: "akismet/akismet.php", name: "akismet", version: "5.3", status: "active", update: "available", update_version: "5.4" }],
    themes: [{ name: "generatepress", version: "3.4", status: "active", update: "none", update_version: null }],
    ...over,
  };
}

describe("matchInventory", () => {
  it("matches vulnerable plugin versions and core", () => {
    const m = matchInventory(FEED, inv());
    expect(m).toHaveLength(2);
    expect(m.find((x) => x.component === "plugin:akismet")).toMatchObject({
      feed_id: "v1:plugin:akismet", installed_version: "5.3", severity: "medium",
    });
    expect(m.find((x) => x.component === "core")).toMatchObject({ severity: "critical", installed_version: "6.4.1" });
  });
  it("does not match patched versions", () => {
    const m = matchInventory(FEED, inv({
      wp_version: "6.4.3",
      plugins: [{ file: "akismet/akismet.php", name: "akismet", version: "5.4", status: "active", update: "none", update_version: null }],
      themes: [{ name: "generatepress", version: "3.0", status: "active", update: "none", update_version: null }],
    }));
    expect(m).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/grading.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/services/security/types.ts`:
```ts
export type CheckResult = "pass" | "fail" | "warn";
export interface SecurityCheck {
  check_id: string;
  result: CheckResult;
  details?: Record<string, unknown>;
}
export interface UptimeRow {
  site_id: string;
  http_status: number | null;
  response_ms: number | null;
  ssl_days_remaining: number | null;
  ok: boolean;
}
export type Severity = "critical" | "high" | "medium" | "low";
export interface Grade { grade: "A" | "B" | "C" | "D" | "F"; score: number }

export function severityFromCvss(cvss: number | null): Severity | null {
  if (cvss === null || cvss <= 0) return null;
  if (cvss >= 9) return "critical";
  if (cvss >= 7) return "high";
  if (cvss >= 4) return "medium";
  return "low";
}

const VULN_WEIGHT: Record<string, number> = { critical: 30, high: 20, medium: 10, low: 5 };

export function computeGrade(input: {
  vulnSeverities: (Severity | null)[];
  checks: SecurityCheck[];
  uptime24h: number | null;
}): Grade {
  let score = 100;
  for (const s of input.vulnSeverities) score -= VULN_WEIGHT[s ?? "low"] ?? 5;
  for (const c of input.checks) {
    if (c.result === "fail") score -= c.check_id === "core_checksums" ? 15 : 5;
    else if (c.result === "warn") score -= 2;
  }
  if (input.uptime24h !== null && input.uptime24h < 99) score -= 5;
  score = Math.max(0, score);
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
  return { grade, score };
}
```

`src/services/security/vulns.ts`:
```ts
import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import { versionInRange } from "@/lib/version";
import type { InventoryPayload } from "@/services/inventory/types";
import { severityFromCvss, type Severity } from "./types";

export interface VulnMatch {
  feed_id: string;
  component: string;            // "plugin:<slug>" | "theme:<slug>" | "core"
  installed_version: string;
  severity: Severity | null;
}

export function matchInventory(entries: FeedEntry[], inv: InventoryPayload): VulnMatch[] {
  const matches: VulnMatch[] = [];
  const targets: Array<{ type: FeedEntry["software_type"]; slug: string; version: string; component: string }> = [
    { type: "core", slug: "wordpress", version: inv.wp_version, component: "core" },
    ...inv.plugins.map((p) => ({ type: "plugin" as const, slug: p.name, version: p.version, component: `plugin:${p.name}` })),
    ...inv.themes.map((t) => ({ type: "theme" as const, slug: t.name, version: t.version, component: `theme:${t.name}` })),
  ];
  for (const target of targets) {
    for (const e of entries) {
      if (e.software_type !== target.type || e.software_slug !== target.slug) continue;
      if (e.affected_versions.some((r) => versionInRange(target.version, r))) {
        matches.push({
          feed_id: e.id,
          component: target.component,
          installed_version: target.version,
          severity: severityFromCvss(e.cvss),
        });
      }
    }
  }
  return matches;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test` → green.

- [ ] **Step 5: Commit**

```powershell
git add src/services/security tests/grading.test.ts; git commit -m "feat: security grading and vulnerability matching"
```

---

### Task 4: Security repo (Supabase)

**Files:**
- Create: `src/services/security/repo.ts`

**Interfaces:**
- Consumes: `FeedEntry`, `VulnMatch`, `SecurityCheck`, `UptimeRow`, `Grade` (Tasks 2–3); tables `vuln_feed`, `site_vulnerabilities`, `security_checks`, `uptime_checks` (migration 0001).
- Produces:
```ts
export interface OpenVuln extends VulnMatch {
  title: string; cve: string | null; fixed_in: string | null; first_seen: string;
}
export interface SecurityRepo {
  replaceFeed(entries: FeedEntry[]): Promise<number>;                       // upsert by id; returns count
  hasFeedEntries(): Promise<boolean>;
  feedEntriesForSlugs(keys: Array<{ type: string; slug: string }>): Promise<FeedEntry[]>;
  syncSiteVulns(siteId: string, matches: VulnMatch[]): Promise<void>;       // upsert open; mark absent as fixed
  openVulns(siteId: string): Promise<OpenVuln[]>;
  insertChecks(siteId: string, runAt: string, checks: SecurityCheck[]): Promise<void>;
  latestChecks(siteId: string): Promise<{ runAt: string; checks: SecurityCheck[] } | null>;
  latestGrade(siteId: string): Promise<Grade | null>;                       // from check_id "grade"
  insertUptime(rows: UptimeRow[]): Promise<void>;
  uptimeSummary(siteId: string): Promise<{ latestOk: boolean | null; responseMs: number | null; sslDays: number | null; uptime24h: number | null }>;
}
export function supabaseSecurityRepo(db: SupabaseClient): SecurityRepo;
```
- The `grade` is stored as a `security_checks` row: `check_id: "grade"`, `result: "pass"`, `details: { grade, score }` — written by the scan (Task 7), read by `latestGrade`.

- [ ] **Step 1: Implement**

`src/services/security/repo.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import type { VulnMatch } from "./vulns";
import type { Grade, SecurityCheck, UptimeRow } from "./types";

export interface OpenVuln extends VulnMatch {
  title: string;
  cve: string | null;
  fixed_in: string | null;
  first_seen: string;
}

export interface SecurityRepo {
  replaceFeed(entries: FeedEntry[]): Promise<number>;
  hasFeedEntries(): Promise<boolean>;
  feedEntriesForSlugs(keys: Array<{ type: string; slug: string }>): Promise<FeedEntry[]>;
  syncSiteVulns(siteId: string, matches: VulnMatch[]): Promise<void>;
  openVulns(siteId: string): Promise<OpenVuln[]>;
  insertChecks(siteId: string, runAt: string, checks: SecurityCheck[]): Promise<void>;
  latestChecks(siteId: string): Promise<{ runAt: string; checks: SecurityCheck[] } | null>;
  latestGrade(siteId: string): Promise<Grade | null>;
  insertUptime(rows: UptimeRow[]): Promise<void>;
  uptimeSummary(siteId: string): Promise<{
    latestOk: boolean | null; responseMs: number | null; sslDays: number | null; uptime24h: number | null;
  }>;
}

function toFeedRow(e: FeedEntry) {
  return {
    id: e.id,
    software_slug: e.software_slug,
    software_type: e.software_type,
    affected_versions: e.affected_versions,
    cve: e.cve,
    cvss: e.cvss,
    title: e.title,
    fixed_in: e.fixed_in,
    updated_at: new Date().toISOString(),
  };
}

function fromFeedRow(r: Record<string, unknown>): FeedEntry {
  return {
    id: r.id as string,
    title: (r.title as string) ?? "",
    cve: (r.cve as string) ?? null,
    cvss: r.cvss === null ? null : Number(r.cvss),
    software_type: r.software_type as FeedEntry["software_type"],
    software_slug: r.software_slug as string,
    affected_versions: (r.affected_versions ?? []) as FeedEntry["affected_versions"],
    fixed_in: (r.fixed_in as string) ?? null,
  };
}

export function supabaseSecurityRepo(db: SupabaseClient): SecurityRepo {
  return {
    async replaceFeed(entries) {
      // Chunked upsert: the scanner feed is thousands of rows.
      for (let i = 0; i < entries.length; i += 500) {
        const chunk = entries.slice(i, i + 500).map(toFeedRow);
        const { error } = await db.from("vuln_feed").upsert(chunk, { onConflict: "id" });
        if (error) throw new Error(`vuln_feed upsert failed: ${error.message}`, { cause: error });
      }
      return entries.length;
    },
    async hasFeedEntries() {
      const { count, error } = await db.from("vuln_feed").select("id", { head: true, count: "exact" });
      if (error) throw new Error(`vuln_feed count failed: ${error.message}`, { cause: error });
      return (count ?? 0) > 0;
    },
    async feedEntriesForSlugs(keys) {
      const slugs = [...new Set(keys.map((k) => k.slug))];
      const results: FeedEntry[] = [];
      for (let i = 0; i < slugs.length; i += 100) {
        const { data, error } = await db.from("vuln_feed").select("*")
          .in("software_slug", slugs.slice(i, i + 100));
        if (error) throw new Error(`vuln_feed query failed: ${error.message}`, { cause: error });
        results.push(...(data ?? []).map(fromFeedRow));
      }
      const wanted = new Set(keys.map((k) => `${k.type}:${k.slug}`));
      return results.filter((e) => wanted.has(`${e.software_type}:${e.software_slug}`));
    },
    async syncSiteVulns(siteId, matches) {
      if (matches.length > 0) {
        const rows = matches.map((m) => ({
          site_id: siteId, feed_id: m.feed_id, component: m.component,
          installed_version: m.installed_version, severity: m.severity, status: "open",
        }));
        const { error } = await db.from("site_vulnerabilities")
          .upsert(rows, { onConflict: "site_id,feed_id,component" });
        if (error) throw new Error(`site_vulnerabilities upsert failed: ${error.message}`, { cause: error });
      }
      const openIds = matches.map((m) => m.feed_id);
      let q = db.from("site_vulnerabilities").update({ status: "fixed" })
        .eq("site_id", siteId).eq("status", "open");
      if (openIds.length > 0) q = q.not("feed_id", "in", `(${openIds.map((x) => `"${x}"`).join(",")})`);
      const { error } = await q;
      if (error) throw new Error(`site_vulnerabilities close failed: ${error.message}`, { cause: error });
    },
    async openVulns(siteId) {
      const { data, error } = await db.from("site_vulnerabilities")
        .select("feed_id,component,installed_version,severity,first_seen,vuln_feed(title,cve,fixed_in)")
        .eq("site_id", siteId).eq("status", "open").order("severity");
      if (error) throw new Error(`openVulns failed: ${error.message}`, { cause: error });
      return (data ?? []).map((r) => {
        const feed = (Array.isArray(r.vuln_feed) ? r.vuln_feed[0] : r.vuln_feed) as
          { title: string; cve: string | null; fixed_in: string | null } | null;
        return {
          feed_id: r.feed_id, component: r.component, installed_version: r.installed_version,
          severity: r.severity, first_seen: r.first_seen,
          title: feed?.title ?? r.feed_id, cve: feed?.cve ?? null, fixed_in: feed?.fixed_in ?? null,
        };
      });
    },
    async insertChecks(siteId, runAt, checks) {
      const rows = checks.map((c) => ({
        site_id: siteId, run_at: runAt, check_id: c.check_id, result: c.result, details: c.details ?? null,
      }));
      const { error } = await db.from("security_checks").insert(rows);
      if (error) throw new Error(`security_checks insert failed: ${error.message}`, { cause: error });
    },
    async latestChecks(siteId) {
      const { data: latest, error: e1 } = await db.from("security_checks")
        .select("run_at").eq("site_id", siteId).order("run_at", { ascending: false }).limit(1).maybeSingle();
      if (e1) throw new Error(`latestChecks failed: ${e1.message}`, { cause: e1 });
      if (!latest) return null;
      const { data, error } = await db.from("security_checks")
        .select("check_id,result,details").eq("site_id", siteId).eq("run_at", latest.run_at);
      if (error) throw new Error(`latestChecks failed: ${error.message}`, { cause: error });
      return {
        runAt: latest.run_at,
        checks: (data ?? []).map((r) => ({
          check_id: r.check_id, result: r.result, details: r.details ?? undefined,
        })),
      };
    },
    async latestGrade(siteId) {
      const { data, error } = await db.from("security_checks")
        .select("details").eq("site_id", siteId).eq("check_id", "grade")
        .order("run_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`latestGrade failed: ${error.message}`, { cause: error });
      const d = data?.details as { grade?: Grade["grade"]; score?: number } | null;
      return d?.grade ? { grade: d.grade, score: d.score ?? 0 } : null;
    },
    async insertUptime(rows) {
      if (rows.length === 0) return;
      const { error } = await db.from("uptime_checks").insert(rows);
      if (error) throw new Error(`uptime insert failed: ${error.message}`, { cause: error });
    },
    async uptimeSummary(siteId) {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data, error } = await db.from("uptime_checks")
        .select("ok,response_ms,ssl_days_remaining,checked_at")
        .eq("site_id", siteId).gte("checked_at", since)
        .order("checked_at", { ascending: false }).limit(500);
      if (error) throw new Error(`uptimeSummary failed: ${error.message}`, { cause: error });
      if (!data?.length) return { latestOk: null, responseMs: null, sslDays: null, uptime24h: null };
      const latest = data[0];
      const okCount = data.filter((r) => r.ok).length;
      return {
        latestOk: latest.ok,
        responseMs: latest.response_ms,
        sslDays: latest.ssl_days_remaining,
        uptime24h: Math.round((okCount / data.length) * 1000) / 10,
      };
    },
  };
}
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit` → 0 errors; `npm test` → green (repo has no unit tests — it is exercised through Task 7's fakes matching this interface; the Supabase impl is thin query code).

```powershell
git add src/services/security/repo.ts; git commit -m "feat: security repo for feed, vulns, checks, and uptime"
```

---

### Task 5: Hardening audit — PHP snippet + HTTP probes (TDD)

**Files:**
- Create: `src/services/security/hardening.ts`
- Test: `tests/hardening.test.ts`

**Interfaces:**
- Consumes: `runPhp`, `SiteMcpClient`, `SecurityCheck`.
- Produces:
```ts
export const HARDENING_PHP: string;
export async function runPhpHardening(client: SiteMcpClient): Promise<SecurityCheck[]>;    // 60s timeout
export async function runHttpHardening(siteUrl: string, fetchImpl?: typeof fetch): Promise<SecurityCheck[]>;
// PHP check_ids: wp_debug, debug_display, file_edit_disabled, https_urls, default_table_prefix,
//   admin_username, default_salts, user_registration, php_version, inactive_plugins, wp_config_permissions
// HTTP check_ids: xmlrpc_enabled, uploads_listing, security_headers
```

- [ ] **Step 1: Write the failing tests**

`tests/hardening.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { HARDENING_PHP, runPhpHardening, runHttpHardening } from "@/services/security/hardening";
import { MockMcpClient } from "@/lib/mcp/mock";

describe("HARDENING_PHP", () => {
  it("covers the 11 PHP-side checks and returns JSON", () => {
    for (const id of [
      "wp_debug", "debug_display", "file_edit_disabled", "https_urls", "default_table_prefix",
      "admin_username", "default_salts", "user_registration", "php_version", "inactive_plugins",
      "wp_config_permissions",
    ]) {
      expect(HARDENING_PHP).toContain(`'${id}'`);
    }
    expect(HARDENING_PHP).toContain("return json_encode");
  });
});

describe("runPhpHardening", () => {
  it("returns the parsed checks", async () => {
    const checks = [{ check_id: "wp_debug", result: "pass" }];
    const mock = new MockMcpClient({
      handler: (name) => {
        expect(name).toBe("novamira/execute-php");
        return { success: true, data: { success: true, return_value: JSON.stringify(checks) } };
      },
    });
    expect(await runPhpHardening(mock)).toEqual(checks);
  });
});

function fetchStub(routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }>) {
  return (async (url: unknown) => {
    const u = String(url);
    const hit = Object.entries(routes).find(([suffix]) => u.endsWith(suffix) || (suffix === "/" && u.endsWith(".test/")));
    const r = hit?.[1] ?? { status: 404 };
    return new Response(r.body ?? "", { status: r.status, headers: r.headers });
  }) as typeof fetch;
}

describe("runHttpHardening", () => {
  it("flags reachable xmlrpc, open uploads listing, and missing headers", async () => {
    const checks = await runHttpHardening("https://site.test", fetchStub({
      "/xmlrpc.php": { status: 405 },
      "/wp-content/uploads/": { status: 200, body: "<title>Index of /wp-content/uploads</title>" },
      "/": { status: 200, headers: {} },
    }));
    const byId = Object.fromEntries(checks.map((c) => [c.check_id, c.result]));
    expect(byId.xmlrpc_enabled).toBe("warn");
    expect(byId.uploads_listing).toBe("fail");
    expect(byId.security_headers).toBe("warn");
  });

  it("passes when xmlrpc blocked, listing off, headers present", async () => {
    const checks = await runHttpHardening("https://site.test", fetchStub({
      "/xmlrpc.php": { status: 403 },
      "/wp-content/uploads/": { status: 403 },
      "/": { status: 200, headers: { "x-frame-options": "SAMEORIGIN" } },
    }));
    const byId = Object.fromEntries(checks.map((c) => [c.check_id, c.result]));
    expect(byId.xmlrpc_enabled).toBe("pass");
    expect(byId.uploads_listing).toBe("pass");
    expect(byId.security_headers).toBe("pass");
  });

  it("treats network failures as warn, not crash", async () => {
    const failing = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    const checks = await runHttpHardening("https://down.test", failing);
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.result === "warn")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/hardening.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/services/security/hardening.ts`:
```ts
import { runPhp } from "@/lib/wpphp";
import type { SiteMcpClient } from "@/lib/mcp/client";
import type { CheckResult, SecurityCheck } from "./types";

export const HARDENING_PHP = `
$checks = array();
$add = function ($id, $result, $details = null) use (&$checks) {
  $checks[] = array('check_id' => $id, 'result' => $result, 'details' => $details);
};
$add('wp_debug', (defined('WP_DEBUG') && WP_DEBUG) ? 'fail' : 'pass');
$add('debug_display', (defined('WP_DEBUG') && WP_DEBUG && (!defined('WP_DEBUG_DISPLAY') || WP_DEBUG_DISPLAY)) ? 'fail' : 'pass');
$add('file_edit_disabled', (defined('DISALLOW_FILE_EDIT') && DISALLOW_FILE_EDIT) ? 'pass' : 'warn');
$https = (strpos(get_option('siteurl'), 'https://') === 0) && (strpos(get_option('home'), 'https://') === 0);
$add('https_urls', $https ? 'pass' : 'fail');
global $wpdb;
$add('default_table_prefix', $wpdb->prefix === 'wp_' ? 'warn' : 'pass', array('prefix' => $wpdb->prefix));
$adminUser = get_user_by('login', 'admin');
$add('admin_username', $adminUser ? 'fail' : 'pass');
$badSalt = defined('AUTH_KEY') ? (strpos(AUTH_KEY, 'put your unique phrase') !== false || strlen(AUTH_KEY) < 32) : true;
$add('default_salts', $badSalt ? 'fail' : 'pass');
$add('user_registration', get_option('users_can_register') ? 'warn' : 'pass');
$php = PHP_VERSION;
$add('php_version', version_compare($php, '8.0', '>=') ? 'pass' : (version_compare($php, '7.4', '>=') ? 'warn' : 'fail'), array('version' => $php));
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
$active = (array) get_option('active_plugins', array());
$inactive = 0;
foreach (array_keys(get_plugins()) as $file) { if (!in_array($file, $active, true)) { $inactive++; } }
$add('inactive_plugins', $inactive === 0 ? 'pass' : 'warn', array('count' => $inactive));
$cfg = ABSPATH . 'wp-config.php';
if (!file_exists($cfg)) { $cfg = dirname(ABSPATH) . '/wp-config.php'; }
$perms = file_exists($cfg) ? (fileperms($cfg) & 0007) : null;
$add('wp_config_permissions', ($perms === null) ? 'warn' : ($perms === 0 ? 'pass' : 'warn'), array('world_bits' => $perms));
return json_encode($checks);
`.trim();

export async function runPhpHardening(client: SiteMcpClient): Promise<SecurityCheck[]> {
  return runPhp<SecurityCheck[]>(client, HARDENING_PHP, 60_000);
}

async function probe(
  fetchImpl: typeof fetch, url: string,
): Promise<{ status: number; body: string; headers: Headers } | null> {
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    const body = (await res.text()).slice(0, 4096);
    return { status: res.status, body, headers: res.headers };
  } catch {
    return null;
  }
}

export async function runHttpHardening(
  siteUrl: string, fetchImpl: typeof fetch = fetch,
): Promise<SecurityCheck[]> {
  const base = siteUrl.replace(/\/+$/, "");
  const [xmlrpc, uploads, home] = await Promise.all([
    probe(fetchImpl, `${base}/xmlrpc.php`),
    probe(fetchImpl, `${base}/wp-content/uploads/`),
    probe(fetchImpl, `${base}/`),
  ]);

  const checks: SecurityCheck[] = [];
  // GET on xmlrpc.php returns 405 ("POST only") when the endpoint is live.
  const xmlrpcResult: CheckResult =
    xmlrpc === null ? "warn" : xmlrpc.status === 405 || (xmlrpc.status === 200 && xmlrpc.body.includes("XML-RPC")) ? "warn" : "pass";
  checks.push({ check_id: "xmlrpc_enabled", result: xmlrpcResult, details: { status: xmlrpc?.status ?? "unreachable" } });

  const listingOpen = uploads !== null && uploads.status === 200 && /index of/i.test(uploads.body);
  checks.push({
    check_id: "uploads_listing",
    result: uploads === null ? "warn" : listingOpen ? "fail" : "pass",
    details: { status: uploads?.status ?? "unreachable" },
  });

  const hasFrameHeader = home !== null &&
    (home.headers.has("x-frame-options") || home.headers.has("content-security-policy"));
  checks.push({
    check_id: "security_headers",
    result: home === null ? "warn" : hasFrameHeader ? "pass" : "warn",
    details: { status: home?.status ?? "unreachable" },
  });
  return checks;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test` → green.

- [ ] **Step 5: Commit**

```powershell
git add src/services/security/hardening.ts tests/hardening.test.ts; git commit -m "feat: hardening audit via execute-php and HTTP probes"
```

---

### Task 6: Core checksums via wordpress.org API in PHP (TDD)

**Files:**
- Create: `src/services/security/checksums.ts`
- Test: `tests/checksums.test.ts`

**Interfaces:**
- Consumes: `runPhp`, `SiteMcpClient`, `SecurityCheck`.
- Produces:
```ts
export const CHECKSUMS_PHP: string;
export async function runChecksums(client: SiteMcpClient): Promise<SecurityCheck>;  // check_id "core_checksums", 180s timeout
// result mapping: mismatched.length > 0 -> fail; ok:false or missing.length > 0 -> warn; else pass
```

- [ ] **Step 1: Write the failing tests**

`tests/checksums.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CHECKSUMS_PHP, runChecksums } from "@/services/security/checksums";
import { MockMcpClient } from "@/lib/mcp/mock";

function client(payload: unknown) {
  return new MockMcpClient({
    handler: () => ({ success: true, data: { success: true, return_value: JSON.stringify(payload) } }),
  });
}

describe("CHECKSUMS_PHP", () => {
  it("fetches the wordpress.org checksums API and skips wp-content", () => {
    expect(CHECKSUMS_PHP).toContain("api.wordpress.org/core/checksums/1.0/");
    expect(CHECKSUMS_PHP).toContain("wp-content/");
    expect(CHECKSUMS_PHP).toContain("md5_file");
    expect(CHECKSUMS_PHP).toContain("return json_encode");
  });
});

describe("runChecksums", () => {
  it("passes on a clean core", async () => {
    const c = await runChecksums(client({ ok: true, checked: 1200, mismatched: [], missing: [] }));
    expect(c).toMatchObject({ check_id: "core_checksums", result: "pass" });
  });
  it("fails on mismatched files", async () => {
    const c = await runChecksums(client({ ok: true, checked: 1200, mismatched: ["wp-includes/x.php"], missing: [] }));
    expect(c.result).toBe("fail");
    expect(c.details?.mismatched).toEqual(["wp-includes/x.php"]);
  });
  it("warns on missing files or API failure", async () => {
    expect((await runChecksums(client({ ok: true, checked: 10, mismatched: [], missing: ["license.txt"] }))).result).toBe("warn");
    expect((await runChecksums(client({ ok: false, error: "no checksums" }))).result).toBe("warn");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/checksums.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/services/security/checksums.ts`:
```ts
import { runPhp } from "@/lib/wpphp";
import type { SiteMcpClient } from "@/lib/mcp/client";
import type { SecurityCheck } from "./types";

export const CHECKSUMS_PHP = `
global $wp_version, $wp_local_package;
$locale = !empty($wp_local_package) ? $wp_local_package : 'en_US';
$url = 'https://api.wordpress.org/core/checksums/1.0/?version=' . rawurlencode($wp_version) . '&locale=' . rawurlencode($locale);
$resp = wp_remote_get($url, array('timeout' => 30));
if (is_wp_error($resp)) { return json_encode(array('ok' => false, 'error' => $resp->get_error_message())); }
$body = json_decode(wp_remote_retrieve_body($resp), true);
$sums = (isset($body['checksums']) && is_array($body['checksums'])) ? $body['checksums'] : null;
if (!$sums) { return json_encode(array('ok' => false, 'error' => 'No checksums published for WordPress ' . $wp_version . ' (' . $locale . ')')); }
$mismatched = array(); $missing = array(); $checked = 0;
foreach ($sums as $file => $md5) {
  if (strpos($file, 'wp-content/') === 0) { continue; }
  $checked++;
  $path = ABSPATH . $file;
  if (!file_exists($path)) { if (count($missing) < 50) { $missing[] = $file; } continue; }
  if (md5_file($path) !== $md5) { if (count($mismatched) < 50) { $mismatched[] = $file; } }
}
return json_encode(array('ok' => true, 'checked' => $checked, 'mismatched' => $mismatched, 'missing' => $missing));
`.trim();

interface ChecksumsResult {
  ok: boolean; checked?: number; mismatched?: string[]; missing?: string[]; error?: string;
}

export async function runChecksums(client: SiteMcpClient): Promise<SecurityCheck> {
  let r: ChecksumsResult;
  try {
    r = await runPhp<ChecksumsResult>(client, CHECKSUMS_PHP, 180_000);
  } catch (e) {
    return {
      check_id: "core_checksums", result: "warn",
      details: { error: e instanceof Error ? e.message : String(e) },
    };
  }
  if (!r.ok) return { check_id: "core_checksums", result: "warn", details: { error: r.error } };
  const mismatched = r.mismatched ?? [];
  const missing = r.missing ?? [];
  return {
    check_id: "core_checksums",
    result: mismatched.length > 0 ? "fail" : missing.length > 0 ? "warn" : "pass",
    details: { checked: r.checked, mismatched, missing },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test` → green.

- [ ] **Step 5: Commit**

```powershell
git add src/services/security/checksums.ts tests/checksums.test.ts; git commit -m "feat: core checksum verification via wordpress.org API"
```

---

### Task 7: Scan orchestrator + feed refresh (TDD)

**Files:**
- Create: `src/services/security/scan.ts`
- Modify: `src/services/jobs/types.ts` (extend union), `src/services/sites/repo.ts` (add two small methods)
- Test: `tests/scan.test.ts`

**Interfaces:**
- Consumes: everything above + `SitesRepo`, `SnapshotsRepo`, `refreshSnapshot`, `decryptSecret`, `McpFactory`, `getOptionalEnv`, `fetchWordfenceFeed`.
- Produces:
```ts
// jobs/types.ts
export type JobType = "snapshot_refresh" | "security_scan" | "vuln_feed_refresh";

// sites/repo.ts — ADD to SitesRepo interface + supabase impl:
recordScanResult(id: string, success: boolean): Promise<void>;
// success: consecutive_failures = 0 and status 'degraded'->'connected';
// failure: consecutive_failures + 1 and (>=3) status 'connected'->'degraded'

// scan.ts
export interface ScanDeps {
  sites: SitesRepo; snapshots: SnapshotsRepo; security: SecurityRepo;
  mcp: McpFactory; fetchImpl?: typeof fetch;
}
export async function securityScan(deps: ScanDeps, siteId: string): Promise<{ grade: Grade; vulnCount: number }>;
export async function refreshVulnFeed(security: SecurityRepo, fetchImpl?: typeof fetch): Promise<{ updated: number; skipped: boolean }>;
```
- `securityScan` flow: load site (`getSite`) → latest snapshot (or `refreshSnapshot` inline if none) → vuln match (only if `hasFeedEntries()`; else a `wordfence_feed` warn check) → open one MCP client for `runPhpHardening` + `runChecksums` (close in finally) → `runHttpHardening(site.url)` → `syncSiteVulns` → `computeGrade` (openVulns severities + all checks + `uptimeSummary().uptime24h`) → `insertChecks(runAt, [...checks, gradeRow])` → `recordScanResult(true)`. On any throw: `recordScanResult(false)` then rethrow (job system handles retry).
- `refreshVulnFeed`: `getOptionalEnv("WORDFENCE_API_KEY")` — missing → `{ updated: 0, skipped: true }`; present → `fetchWordfenceFeed` → `replaceFeed`.

- [ ] **Step 1: Write the failing tests**

`tests/scan.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { securityScan, refreshVulnFeed, type ScanDeps } from "@/services/security/scan";
import type { SecurityRepo, OpenVuln } from "@/services/security/repo";
import type { FeedEntry } from "@/lib/adapters/vulnfeed/wordfence";
import type { SecurityCheck } from "@/services/security/types";
import type { SitesRepo } from "@/services/sites/repo";
import type { SnapshotsRepo } from "@/services/inventory/repo";
import type { InventoryPayload } from "@/services/inventory/types";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
afterEach(() => { delete process.env.WORDFENCE_API_KEY; });

const INV: InventoryPayload = {
  collected_at: "2026-08-28T00:00:00Z", wp_version: "6.4.1", php_version: "8.2",
  core_update: null, admin_users: [],
  plugins: [{ file: "akismet/akismet.php", name: "akismet", version: "5.3", status: "active", update: "none", update_version: null }],
  themes: [],
};

const FEED: FeedEntry[] = [{
  id: "v1:plugin:akismet", title: "Akismet XSS", cve: null, cvss: 9.5,
  software_type: "plugin", software_slug: "akismet",
  affected_versions: [{ from_version: "*", from_inclusive: true, to_version: "5.3.9", to_inclusive: true }],
  fixed_in: "5.4",
}];

function fakeSecurityRepo(feed: FeedEntry[]) {
  const state = {
    feed, synced: [] as unknown[], inserted: [] as Array<{ runAt: string; checks: SecurityCheck[] }>,
  };
  const repo: SecurityRepo = {
    async replaceFeed(entries) { state.feed = entries; return entries.length; },
    async hasFeedEntries() { return state.feed.length > 0; },
    async feedEntriesForSlugs() { return state.feed; },
    async syncSiteVulns(_s, matches) { state.synced = matches; },
    async openVulns() {
      return state.synced.map((m) => ({ ...(m as OpenVuln), title: "t", cve: null, fixed_in: null, first_seen: "" }));
    },
    async insertChecks(_s, runAt, checks) { state.inserted.push({ runAt, checks }); },
    async latestChecks() { return null; },
    async latestGrade() { return null; },
    async insertUptime() {},
    async uptimeSummary() { return { latestOk: true, responseMs: 200, sslDays: 90, uptime24h: 100 }; },
  };
  return { repo, state };
}

function fakeSites() {
  const scanResults: boolean[] = [];
  let encrypted = "";
  const sites = {
    async getSite(id: string) {
      return id === "site-1"
        ? { id, name: "S", url: "https://site.test", mcp_endpoint: "https://site.test/wp-json/mcp/novamira",
            wp_username: "admin", status: "connected", client_label: null,
            capabilities: { abilities: [] }, created_at: "", updated_at: "" }
        : null;
    },
    async getSiteCredentials() {
      return { mcp_endpoint: "https://site.test/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: encrypted };
    },
    async recordScanResult(_id: string, success: boolean) { scanResults.push(success); },
  } as unknown as SitesRepo;
  return { sites, scanResults, setCreds: (v: string) => { encrypted = v; } };
}

const snapshotsWith = (payload: InventoryPayload | null): SnapshotsRepo => ({
  async insertSnapshot() {},
  async latestSnapshot() { return payload ? { payload, taken_at: "2026-08-28T00:00:00Z" } : null; },
});

function phpClient() {
  // Serves both hardening (array) and checksums (object) snippets.
  return new MockMcpClient({
    handler: (_n, args) => {
      const code = (args as { code: string }).code;
      const value = code.includes("core/checksums")
        ? { ok: true, checked: 100, mismatched: [], missing: [] }
        : [{ check_id: "wp_debug", result: "pass" }];
      return { success: true, data: { success: true, return_value: JSON.stringify(value) } };
    },
  });
}

const okFetch = (async () => new Response("", { status: 403, headers: { "x-frame-options": "DENY" } })) as typeof fetch;

describe("securityScan", () => {
  it("matches vulns, runs checks, stores a grade row, records success", async () => {
    const sec = fakeSecurityRepo(FEED);
    const f = fakeSites();
    f.setCreds(await encryptSecret("pass"));
    const deps: ScanDeps = {
      sites: f.sites, snapshots: snapshotsWith(INV), security: sec.repo,
      mcp: async () => phpClient(), fetchImpl: okFetch,
    };
    const res = await securityScan(deps, "site-1");
    expect(res.vulnCount).toBe(1);
    expect(res.grade.grade).toBeDefined();
    // critical vuln (-30) dominates; base checks mostly pass
    expect(res.grade.score).toBeLessThanOrEqual(70);
    const run = sec.state.inserted[0];
    expect(run.checks.find((c) => c.check_id === "grade")?.details).toMatchObject({ grade: res.grade.grade });
    expect(run.checks.find((c) => c.check_id === "core_checksums")?.result).toBe("pass");
    expect(f.scanResults).toEqual([true]);
  });

  it("records a wordfence_feed warn check when the feed cache is empty", async () => {
    const sec = fakeSecurityRepo([]);
    const f = fakeSites();
    f.setCreds(await encryptSecret("pass"));
    const deps: ScanDeps = {
      sites: f.sites, snapshots: snapshotsWith(INV), security: sec.repo,
      mcp: async () => phpClient(), fetchImpl: okFetch,
    };
    const res = await securityScan(deps, "site-1");
    expect(res.vulnCount).toBe(0);
    expect(sec.state.inserted[0].checks.find((c) => c.check_id === "wordfence_feed")?.result).toBe("warn");
  });

  it("records failure on error and rethrows", async () => {
    const sec = fakeSecurityRepo(FEED);
    const f = fakeSites();
    f.setCreds(await encryptSecret("pass"));
    const deps: ScanDeps = {
      sites: f.sites, snapshots: snapshotsWith(INV), security: sec.repo,
      mcp: async () => { throw new Error("unreachable"); }, fetchImpl: okFetch,
    };
    await expect(securityScan(deps, "site-1")).rejects.toThrow("unreachable");
    expect(f.scanResults).toEqual([false]);
  });
});

describe("refreshVulnFeed", () => {
  it("skips without a key", async () => {
    const sec = fakeSecurityRepo([]);
    expect(await refreshVulnFeed(sec.repo)).toEqual({ updated: 0, skipped: true });
  });
  it("fetches and stores with a key", async () => {
    process.env.WORDFENCE_API_KEY = "k";
    const sec = fakeSecurityRepo([]);
    const feedJson = {
      "u1": { id: "u1", title: "T", cve: null, cvss: { score: 5 }, software: [{
        type: "plugin", slug: "x",
        affected_versions: { "r": { from_version: "*", from_inclusive: true, to_version: "1.0", to_inclusive: true } },
        patched_versions: ["1.1"],
      }]},
    };
    const fetchImpl = (async () => new Response(JSON.stringify(feedJson), { status: 200 })) as typeof fetch;
    const res = await refreshVulnFeed(sec.repo, fetchImpl);
    expect(res).toEqual({ updated: 1, skipped: false });
    expect(sec.state.feed[0].software_slug).toBe("x");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/scan.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `src/services/jobs/types.ts` change the union:
```ts
export type JobType = "snapshot_refresh" | "security_scan" | "vuln_feed_refresh";
```

In `src/services/sites/repo.ts`, add to the `SitesRepo` interface:
```ts
recordScanResult(id: string, success: boolean): Promise<void>;
```
and to `supabaseSitesRepo`:
```ts
async recordScanResult(id, success) {
  const { data, error } = await db.from("sites")
    .select("consecutive_failures,status").eq("id", id).maybeSingle();
  if (error) throw new Error(`recordScanResult read failed: ${error.message}`, { cause: error });
  if (!data) return;
  if (success) {
    const patch: Record<string, unknown> = { consecutive_failures: 0 };
    if (data.status === "degraded") patch.status = "connected";
    const { error: e2 } = await db.from("sites").update(patch).eq("id", id);
    if (e2) throw new Error(`recordScanResult failed: ${e2.message}`, { cause: e2 });
  } else {
    const failures = (data.consecutive_failures ?? 0) + 1;
    const patch: Record<string, unknown> = { consecutive_failures: failures };
    if (failures >= 3 && data.status === "connected") patch.status = "degraded";
    const { error: e2 } = await db.from("sites").update(patch).eq("id", id);
    if (e2) throw new Error(`recordScanResult failed: ${e2.message}`, { cause: e2 });
  }
},
```
(The Phase 2 test files build `SitesRepo` fakes via `as unknown as SitesRepo` casts, so the interface addition does not break them.)

`src/services/security/scan.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit**

```powershell
git add src/services/security src/services/jobs/types.ts src/services/sites/repo.ts tests/scan.test.ts; git commit -m "feat: security scan orchestrator with feed refresh and degraded-site tracking"
```

---

### Task 8: Uptime service + cron routes wiring (TDD on uptime)

**Files:**
- Create: `src/services/security/uptime.ts`, `src/app/api/cron/uptime/route.ts`
- Modify: `src/app/api/cron/process/route.ts` (add handlers), `src/app/api/cron/enqueue/route.ts` (add job types), `docs/ops/scheduling.md` (uptime schedule), `README.md` (env + jobs)
- Test: `tests/uptime.test.ts`

**Interfaces:**
- Consumes: `UptimeRow`, `SecurityRepo.insertUptime`, `isAuthorizedCronRequest`, jobs service, `securityScan`, `refreshVulnFeed`, `supabaseSecurityRepo`.
- Produces:
```ts
// uptime.ts
export async function sslDaysRemaining(hostname: string): Promise<number | null>;  // node:tls, 10s timeout, null on any failure
export async function checkSite(url: string, fetchImpl?: typeof fetch): Promise<Omit<UptimeRow, "site_id">>;
// GET url, 15s timeout, ok = status 200-399; response_ms measured; ssl checked only for https URLs
```

- [ ] **Step 1: Write the failing tests**

`tests/uptime.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { checkSite } from "@/services/security/uptime";

describe("checkSite", () => {
  it("reports ok with timing for a healthy site", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    const row = await checkSite("http://site.test", fetchImpl); // http: skips TLS branch
    expect(row.ok).toBe(true);
    expect(row.http_status).toBe(200);
    expect(row.response_ms).toBeGreaterThanOrEqual(0);
    expect(row.ssl_days_remaining).toBeNull();
  });
  it("reports not-ok for 5xx", async () => {
    const fetchImpl = (async () => new Response("err", { status: 502 })) as typeof fetch;
    const row = await checkSite("http://site.test", fetchImpl);
    expect(row.ok).toBe(false);
    expect(row.http_status).toBe(502);
  });
  it("reports not-ok with null status when unreachable", async () => {
    const fetchImpl = (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    const row = await checkSite("http://down.test", fetchImpl);
    expect(row.ok).toBe(false);
    expect(row.http_status).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/uptime.test.ts` → FAIL.

- [ ] **Step 3: Implement uptime service**

`src/services/security/uptime.ts`:
```ts
import tls from "node:tls";
import type { UptimeRow } from "./types";

export function sslDaysRemaining(hostname: string): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, timeout: 10_000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) return resolve(null);
        const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
        resolve(Number.isFinite(days) ? days : null);
      },
    );
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

export async function checkSite(
  url: string, fetchImpl: typeof fetch = fetch,
): Promise<Omit<UptimeRow, "site_id">> {
  const started = Date.now();
  let status: number | null = null;
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "wp-control-panel-uptime/1.0" },
    });
    status = res.status;
  } catch {
    status = null;
  }
  const response_ms = Date.now() - started;
  let ssl_days_remaining: number | null = null;
  if (url.startsWith("https://")) {
    try {
      ssl_days_remaining = await sslDaysRemaining(new URL(url).hostname);
    } catch {
      ssl_days_remaining = null;
    }
  }
  return {
    http_status: status,
    response_ms,
    ssl_days_remaining,
    ok: status !== null && status >= 200 && status < 400,
  };
}
```

- [ ] **Step 4: Implement the uptime route**

`src/app/api/cron/uptime/route.ts`:
```ts
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { checkSite } from "@/services/security/uptime";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createServiceSupabase } from "@/lib/supabase/server";
import type { UptimeRow } from "@/services/security/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceSupabase();
  const sites = (await supabaseSitesRepo(db).listSites()).filter((s) => s.status !== "disabled");
  const rows: UptimeRow[] = await Promise.all(
    sites.map(async (s) => ({ site_id: s.id, ...(await checkSite(s.url)) })),
  );
  await supabaseSecurityRepo(db).insertUptime(rows);
  return NextResponse.json({ ok: true, sites: rows.length, down: rows.filter((r) => !r.ok).length });
}

export const POST = run;
export const GET = run;
```

- [ ] **Step 5: Wire the process and enqueue routes**

In `src/app/api/cron/process/route.ts`, extend the handlers object (keep existing `snapshot_refresh`) and add imports for `securityScan`, `refreshVulnFeed`, `supabaseSecurityRepo`:
```ts
const handlers: JobHandlers = {
  snapshot_refresh: async ({ job }) => {
    if (!job.site_id) throw new Error("snapshot_refresh requires site_id");
    await refreshSnapshot(
      { sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db), mcp: createSiteMcpClient },
      job.site_id,
    );
  },
  security_scan: async ({ job }) => {
    if (!job.site_id) throw new Error("security_scan requires site_id");
    await securityScan(
      {
        sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db),
        security: supabaseSecurityRepo(db), mcp: createSiteMcpClient,
      },
      job.site_id,
    );
  },
  vuln_feed_refresh: async () => {
    await refreshVulnFeed(supabaseSecurityRepo(db));
  },
};
```

In `src/app/api/cron/enqueue/route.ts`, after the existing per-site loop add per-site scans and the global feed job (imports unchanged plus nothing new needed):
```ts
  let scans = 0;
  for (const site of sites) {
    if (site.status === "disabled") continue;
    const res = await enqueueJob(jobs, "security_scan", site.id, {}, { dedupe: true });
    if (res) scans++;
  }
  const feedJob = await enqueueJob(jobs, "vuln_feed_refresh", null, {}, { dedupe: true });
  return NextResponse.json({ ok: true, sites: sites.length, enqueued, scans, feed: Boolean(feedJob) });
```
(Replace the existing final `return NextResponse.json(...)` line.)

- [ ] **Step 6: Docs**

In `docs/ops/scheduling.md`, add after the nightly enqueue block (inside the same SQL fence):
```sql
-- uptime + SSL checks every 5 minutes
select cron.schedule('wp-panel-uptime', '*/5 * * * *', $$
  select net.http_post(
    url := 'APP_URL/api/cron/uptime',
    headers := jsonb_build_object('x-cron-secret', 'CRON_SECRET'),
    timeout_milliseconds := 60000
  );
$$);
```

In `README.md`, extend the "Background jobs" section with:
```markdown
- Every 5 min: `/api/cron/uptime` checks HTTP + SSL expiry for all sites.
- Nightly: `security_scan` per site (vulnerabilities, hardening, checksums, grade)
  and one `vuln_feed_refresh` (requires `WORDFENCE_API_KEY` — free key from
  wordfence.com/threat-intel; without it, vulnerability matching is skipped).
```

- [ ] **Step 7: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — all green.

```powershell
git add src/services/security/uptime.ts src/app/api tests/uptime.test.ts docs/ops/scheduling.md README.md; git commit -m "feat: uptime cron and security job wiring"
```

---

### Task 9: Security tab UI + dashboard grade chips

**Files:**
- Create: `src/app/(dashboard)/sites/[id]/security-actions.ts`, `src/app/(dashboard)/sites/[id]/security/page.tsx`
- Modify: `src/app/(dashboard)/sites/[id]/tabs.tsx` (Security → LIVE), `src/app/(dashboard)/dashboard/page.tsx` (grade chip)

**Interfaces:**
- Consumes: `securityScan`, `supabaseSecurityRepo` (`openVulns`, `latestChecks`, `latestGrade`, `uptimeSummary`), `ManageForm`/`ManageFormAction`, `manageAction`, existing page patterns.
- Produces: route `/sites/[id]/security`; server action `runSecurityScanAction(siteId): Promise<{ok, error?}>`.

- [ ] **Step 1: Implement the server action**

`src/app/(dashboard)/sites/[id]/security-actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { securityScan } from "@/services/security/scan";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

export async function runSecurityScanAction(siteId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const db = createServiceSupabase();
  try {
    await securityScan(
      {
        sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db),
        security: supabaseSecurityRepo(db), mcp: createSiteMcpClient,
      },
      siteId,
    );
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.security_scan", detail: { manual: true },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Scan failed" };
  }
  revalidatePath(`/sites/${siteId}/security`);
  revalidatePath("/dashboard");
  return { ok: true };
}
```

- [ ] **Step 2: Flip the Security tab live**

In `src/app/(dashboard)/sites/[id]/tabs.tsx`: move Security out of `COMING` into `LIVE`:
```ts
const LIVE = [
  { key: "overview", label: "Overview", href: (id: string) => `/sites/${id}` },
  { key: "plugins", label: "Plugins", href: (id: string) => `/sites/${id}/plugins` },
  { key: "themes", label: "Themes", href: (id: string) => `/sites/${id}/themes` },
  { key: "security", label: "Security", href: (id: string) => `/sites/${id}/security` },
] as const;
const COMING = ["SEO", "GeoGrid", "Reports"];
```

- [ ] **Step 3: Implement the Security page**

`src/app/(dashboard)/sites/[id]/security/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { SiteTabs } from "../tabs";
import { ManageForm, type ManageFormAction } from "../action-form";
import { manageAction } from "../manage-actions";
import { runSecurityScanAction } from "../security-actions";
import type { Severity } from "@/services/security/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GRADE_STYLE: Record<string, string> = {
  A: "bg-green-100 text-green-800", B: "bg-lime-100 text-lime-800",
  C: "bg-amber-100 text-amber-800", D: "bg-orange-100 text-orange-800",
  F: "bg-red-100 text-red-800",
};
const SEV_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-800", high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-100 text-amber-800", low: "bg-slate-200 text-slate-600",
};
const CHECK_LABELS: Record<string, string> = {
  wp_debug: "Debug mode off", debug_display: "Debug output hidden",
  file_edit_disabled: "File editor disabled", https_urls: "HTTPS site URLs",
  default_table_prefix: "Custom table prefix", admin_username: "No 'admin' username",
  default_salts: "Unique auth salts", user_registration: "Open registration off",
  php_version: "Supported PHP version", inactive_plugins: "No inactive plugins",
  wp_config_permissions: "wp-config.php permissions", xmlrpc_enabled: "XML-RPC blocked",
  uploads_listing: "Directory listing off", security_headers: "Clickjacking headers",
  core_checksums: "Core files unmodified", wordfence_feed: "Vulnerability feed",
};

export default async function SecurityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const security = supabaseSecurityRepo(db);
  const [grade, vulns, latest, uptime] = await Promise.all([
    security.latestGrade(id), security.openVulns(id), security.latestChecks(id), security.uptimeSummary(id),
  ]);
  const checks = (latest?.checks ?? []).filter((c) => c.check_id !== "grade");
  const scan = runSecurityScanAction.bind(null, id) as unknown as ManageFormAction;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Security</p>
      <SiteTabs siteId={id} active="security" />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {grade ? (
            <>
              <span className={`rounded-lg px-4 py-2 text-2xl font-bold ${GRADE_STYLE[grade.grade]}`}>
                {grade.grade}
              </span>
              <div className="text-sm text-slate-500">
                <p>Score {grade.score}/100</p>
                {latest && <p>Scanned {new Date(latest.runAt).toLocaleString()}</p>}
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500">No scan yet — run the first one.</p>
          )}
        </div>
        <ManageForm action={scan} label="Run security scan" pendingLabel="Scanning… (may take a few minutes)"
          confirmMessage={`Run a full security scan on ${site.name} now?`}
          buttonClassName="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Uptime (24h)", value: uptime.uptime24h !== null ? `${uptime.uptime24h}%` : "—" },
          { label: "Status", value: uptime.latestOk === null ? "—" : uptime.latestOk ? "Up" : "Down" },
          { label: "Response", value: uptime.responseMs !== null ? `${uptime.responseMs} ms` : "—" },
          { label: "SSL expires", value: uptime.sslDays !== null ? `${uptime.sslDays} days` : "—" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border bg-white p-3 text-center shadow-sm">
            <p className="text-lg font-semibold">{s.value}</p>
            <p className="text-xs text-slate-500">{s.label}</p>
          </div>
        ))}
      </div>

      <section className="mb-6 rounded-lg border bg-white shadow-sm">
        <h2 className="border-b px-4 py-3 font-medium">
          Vulnerabilities {vulns.length > 0 && <span className="text-red-600">({vulns.length})</span>}
        </h2>
        {vulns.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">
            {latest ? "No known vulnerabilities matched." : "Run a scan to check for vulnerabilities."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Component</th>
                  <th className="px-4 py-2">Vulnerability</th>
                  <th className="px-4 py-2">Severity</th>
                  <th className="px-4 py-2">Installed</th>
                  <th className="px-4 py-2">Fixed in</th>
                </tr>
              </thead>
              <tbody>
                {vulns.map((v) => (
                  <tr key={`${v.feed_id}:${v.component}`} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium">{v.component}</td>
                    <td className="px-4 py-2">
                      {v.title}
                      {v.cve && (
                        <a href={`https://www.cve.org/CVERecord?id=${v.cve}`} target="_blank" rel="noreferrer"
                          className="ml-2 text-xs text-slate-500 underline">{v.cve}</a>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${SEV_STYLE[(v.severity ?? "low") as Severity]}`}>
                        {v.severity ?? "unknown"}
                      </span>
                    </td>
                    <td className="px-4 py-2">{v.installed_version}</td>
                    <td className="px-4 py-2">{v.fixed_in ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {vulns.length > 0 && (
          <p className="border-t px-4 py-3 text-xs text-slate-500">
            Fix vulnerable plugins from the Plugins tab (update to the fixed version, or deactivate).
          </p>
        )}
      </section>

      <section className="rounded-lg border bg-white shadow-sm">
        <h2 className="border-b px-4 py-3 font-medium">Hardening checklist</h2>
        {checks.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">Run a scan to populate the checklist.</p>
        ) : (
          <ul className="divide-y">
            {checks.map((c) => (
              <li key={c.check_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span>{CHECK_LABELS[c.check_id] ?? c.check_id}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${
                  c.result === "pass" ? "bg-green-100 text-green-800"
                    : c.result === "fail" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>
                  {c.result}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
```
Note: `manageAction` is imported for future per-vuln shortcuts but currently unused — REMOVE that import to keep the build clean (no unused imports).

- [ ] **Step 4: Dashboard grade chips**

In `src/app/(dashboard)/dashboard/page.tsx`:
- Add import: `import { supabaseSecurityRepo } from "@/services/security/repo";`
- Alongside the snapshot fetch, gather grades:
```ts
const securityRepo = supabaseSecurityRepo(db);
const grades = new Map<string, string>();
await Promise.all(sites.map(async (s) => {
  const g = await securityRepo.latestGrade(s.id);
  if (g) grades.set(s.id, g.grade);
}));
```
- Add a chip in the card footer paragraph (after the updates badge), using the same `GRADE_STYLE` map inlined:
```tsx
{grades.has(s.id) && (
  <span className={`rounded-full px-2 py-0.5 ${
    { A: "bg-green-100 text-green-800", B: "bg-lime-100 text-lime-800", C: "bg-amber-100 text-amber-800",
      D: "bg-orange-100 text-orange-800", F: "bg-red-100 text-red-800" }[grades.get(s.id)!]
  }`}>
    security {grades.get(s.id)}
  </span>
)}
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — all green.

```powershell
git add "src/app/(dashboard)"; git commit -m "feat: security tab with grade, vulns, checklist, and dashboard grade chips"
```

---

## Self-Review Notes

- **Spec §6.2 coverage:** vuln matching (T2-T4, T7), hardening ~14 checks (T5), checksums without WP-CLI (T6), uptime+SSL every 5 min (T8), grade A–F with fix guidance pointing at existing manage actions (T9). One-click `fix` shortcuts beyond update/deactivate are deferred (YAGNI — wp-config edits are risky; revisit after Phase 4).
- **Type consistency:** `SecurityCheck`/`Grade`/`Severity` defined once in types.ts and consumed by T5-T9; `SecurityRepo` interface (T4) matches the fake in T7's tests method-for-method; `JobType` extension consumed by both cron routes; `recordScanResult` added to `SitesRepo` with impl and used only by scan.
- **Judgment calls:** grade persisted as a `security_checks` row (`check_id: "grade"`) to avoid a migration; feed parse verified by fixture — first real fetch should be sanity-checked during execution once the user provides `WORDFENCE_API_KEY`; `severityFromCvss(0)` → null treated as low weight (−5).
