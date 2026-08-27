# Phase 4: Plugin Marketplace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Marketplace page that searches wordpress.org, installs plugins (single site or bulk across sites with a live batch-progress page), accepts uploaded plugin ZIPs, plus a one-click child theme installer on the Themes tab.

**Architecture:** wp.org search runs server-side through a typed adapter. Installation happens inside WordPress via `Plugin_Upgrader->install(<zip URL>)` over `execute-php` — for wp.org plugins the URL is `downloads.wordpress.org/plugin/<slug>.latest-stable.zip`; for uploads the ZIP goes to a private Supabase Storage bucket from the browser via signed upload URLs (bypassing Vercel's 4.5MB body limit), and the job handler resolves a signed download URL at run time. Bulk = one `plugin_install` job per site sharing a `batch_id`, processed by the existing queue; a batch page polls `/api/batches/[id]`. Job handlers are extracted into a shared module so the cron route and a "process queue now" action use one code path.

**Tech Stack:** Existing stack. No new dependencies (`crypto.randomUUID` from Node).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md` §6.5-6.6 + §3.1 amendment. **No WP-CLI** — all WordPress work via `runPhp` (`@/lib/wpphp`); untrusted values embedded ONLY via `phpString` base64 (booleans/internal values may be PHP literals). Slugs validated with `SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i` before use.
- wp.org API: `https://api.wordpress.org/plugins/info/1.2/` with `action=query_plugins` (search / `browse=popular`); cache with `fetch(..., { next: { revalidate: 3600 } })`. Treat as best-effort: adapter failures render an error note, never crash the page.
- Storage: private bucket `plugins` (created in migration `0003_storage_plugins.sql`). Browser uploads use `createSignedUploadUrl` (server) + `uploadToSignedUrl` (browser). ZIP only, max 50MB client-side check. Handler resolves `createSignedUrl(path, 3600)` at job run time.
- Jobs: new `JobType` `"plugin_install"`, payload `{ source: {kind:"wporg", slug} | {kind:"upload", path}, activate: boolean }`; bulk installs share a `batch_id` (uuid). Existing rules unchanged (3 attempts, backoff, dedupe not used for installs — same plugin may be reinstalled intentionally).
- Install timeout 300s per job (`HEAVY`), page/action `maxDuration = 300`.
- Every user-initiated mutation: confirm dialog + activity log (`site.plugin_install`, `site.child_theme`). Batch creation logs once per site (the install itself logs on execution — no, see Task 3: installPlugin logs; batch creation does NOT double-log).
- Child theme (spec §6.6): refuse if the active theme is already a child (`get_template() !== get_stylesheet()`); never overwrite an existing directory; generated files: `style.css` (Theme Name + Template header) and `functions.php` (parent style enqueue); optional activate.
- Responsive + a11y as established (`overflow-x-auto` tables, `min-h-10` buttons, flex-wrap, labeled inputs, aria-live errors). Impeccable audit after UI tasks (orchestrator-level).
- Middleware note: `/api/batches/` is NOT in the public prefixes, so the route is session-gated by middleware; it must still call `requireUser()`-equivalent check? No — middleware already blocks anon; the route additionally returns 401 JSON when no session (see Task 4) to avoid HTML redirects on fetch.
- Commit after every task; PowerShell-safe commands.

## File Structure (new/changed)

```
supabase/migrations/0003_storage_plugins.sql
src/lib/adapters/wporg.ts                     # searchPlugins/popularPlugins + types
src/services/jobs/types.ts                    # + "plugin_install"
src/services/jobs/repo.ts                     # insert() gains batch_id; + batchJobs()
src/services/jobs/service.ts                  # + enqueueBatch()
src/services/jobs/handlers.ts                 # buildJobHandlers(db) shared by cron + action
src/services/marketplace/install.ts           # buildInstallPhp + installPlugin
src/services/childtheme/service.ts            # CHILD_THEME_PHP builder + createChildTheme
src/app/api/cron/process/route.ts             # refactor to buildJobHandlers
src/app/api/batches/[id]/route.ts             # batch status JSON
src/app/(dashboard)/marketplace/page.tsx      # search + grid + upload
src/app/(dashboard)/marketplace/actions.ts    # server actions (install/batch/upload-prep/process-queue)
src/app/(dashboard)/marketplace/install-panel.tsx   # client: site multiselect + activate
src/app/(dashboard)/marketplace/upload-card.tsx     # client: file → signed upload → batch
src/app/(dashboard)/marketplace/batches/[id]/page.tsx  # progress page (client poller inside)
src/app/(dashboard)/marketplace/batches/[id]/poller.tsx
src/app/(dashboard)/layout.tsx                # + Marketplace nav link
src/app/(dashboard)/sites/[id]/plugins/page.tsx  # + "Install new plugin" link
src/app/(dashboard)/sites/[id]/themes/page.tsx   # + child theme card
src/app/(dashboard)/sites/[id]/child-theme-actions.ts
tests/{wporg,jobs-batch,install,childtheme}.test.ts
README.md
```

---

### Task 1: wp.org adapter (TDD)

**Files:**
- Create: `src/lib/adapters/wporg.ts`
- Test: `tests/wporg.test.ts`

**Interfaces:**
- Produces:
```ts
export interface WpOrgPlugin {
  slug: string; name: string; version: string; author: string;      // author stripped of HTML
  rating: number;               // 0-100
  num_ratings: number;
  active_installs: number;
  short_description: string;
  icon: string | null;          // best icon URL
  requires: string | null; tested: string | null; requires_php: string | null;
}
export interface WpOrgSearchResult { plugins: WpOrgPlugin[]; total: number; pages: number }
export async function searchPlugins(query: string, page?: number, fetchImpl?: typeof fetch): Promise<WpOrgSearchResult>;
export async function popularPlugins(page?: number, fetchImpl?: typeof fetch): Promise<WpOrgSearchResult>;
```

- [ ] **Step 1: Write the failing tests**

`tests/wporg.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { searchPlugins, popularPlugins } from "@/lib/adapters/wporg";

const API_RESPONSE = {
  info: { page: 1, pages: 3, results: 55 },
  plugins: [
    {
      slug: "akismet", name: "Akismet <strong>Anti-spam</strong>",
      version: "5.4", author: '<a href="https://automattic.com">Automattic</a>',
      rating: 92, num_ratings: 1050, active_installs: 5000000,
      short_description: "Spam protection.",
      icons: { "2x": "https://ps.w.org/akismet/assets/icon-256x256.png", "1x": "https://ps.w.org/akismet/assets/icon-128x128.png" },
      requires: "5.8", tested: "6.9", requires_php: "7.2",
    },
    { slug: "noicon", name: "NoIcon", version: "1.0", author: "Dev", rating: 0, num_ratings: 0,
      active_installs: 10, short_description: "x", icons: {}, requires: false, tested: false, requires_php: false },
  ],
};

function stub(expectUrlPart: string) {
  return (async (url: unknown) => {
    expect(String(url)).toContain(expectUrlPart);
    return new Response(JSON.stringify(API_RESPONSE), { status: 200 });
  }) as typeof fetch;
}

describe("searchPlugins", () => {
  it("queries the 1.2 API and normalizes plugins", async () => {
    const res = await searchPlugins("spam", 1, stub("action=query_plugins"));
    expect(res.total).toBe(55);
    expect(res.pages).toBe(3);
    const p = res.plugins[0];
    expect(p).toMatchObject({
      slug: "akismet", name: "Akismet Anti-spam", author: "Automattic",
      rating: 92, active_installs: 5000000, icon: "https://ps.w.org/akismet/assets/icon-256x256.png",
      requires: "5.8",
    });
    // false → null normalization; empty icons → null
    expect(res.plugins[1]).toMatchObject({ icon: null, requires: null, tested: null, requires_php: null });
  });
  it("URL-encodes the query", async () => {
    await searchPlugins("a b&c", 1, stub("request%5Bsearch%5D=a+b%26c"));
  });
  it("throws a friendly error on non-200", async () => {
    const bad = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    await expect(searchPlugins("x", 1, bad)).rejects.toThrow(/wordpress\.org.*503/i);
  });
});

describe("popularPlugins", () => {
  it("uses browse=popular", async () => {
    const res = await popularPlugins(2, stub("request%5Bbrowse%5D=popular"));
    expect(res.plugins).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/wporg.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/adapters/wporg.ts`:
```ts
export interface WpOrgPlugin {
  slug: string; name: string; version: string; author: string;
  rating: number; num_ratings: number; active_installs: number;
  short_description: string; icon: string | null;
  requires: string | null; tested: string | null; requires_php: string | null;
}
export interface WpOrgSearchResult { plugins: WpOrgPlugin[]; total: number; pages: number }

const API = "https://api.wordpress.org/plugins/info/1.2/";
const FIELDS =
  "&request[fields][icons]=true&request[fields][active_installs]=true&request[fields][short_description]=true";

function stripHtml(s: unknown): string {
  return String(s ?? "").replace(/<[^>]*>/g, "").trim();
}
function orNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function normalize(raw: unknown): WpOrgSearchResult {
  const r = raw as {
    info?: { pages?: number; results?: number };
    plugins?: Array<Record<string, unknown>>;
  };
  const plugins = (r.plugins ?? []).map((p): WpOrgPlugin => {
    const icons = (p.icons ?? {}) as Record<string, string>;
    return {
      slug: String(p.slug ?? ""),
      name: stripHtml(p.name),
      version: String(p.version ?? ""),
      author: stripHtml(p.author),
      rating: Number(p.rating ?? 0),
      num_ratings: Number(p.num_ratings ?? 0),
      active_installs: Number(p.active_installs ?? 0),
      short_description: stripHtml(p.short_description),
      icon: icons["2x"] ?? icons["1x"] ?? icons.svg ?? icons.default ?? null,
      requires: orNull(p.requires),
      tested: orNull(p.tested),
      requires_php: orNull(p.requires_php),
    };
  }).filter((p) => p.slug);
  return { plugins, total: Number(r.info?.results ?? plugins.length), pages: Number(r.info?.pages ?? 1) };
}

async function query(params: URLSearchParams, fetchImpl: typeof fetch): Promise<WpOrgSearchResult> {
  const url = `${API}?action=query_plugins&${params.toString()}${FIELDS}`;
  const res = await fetchImpl(url, { next: { revalidate: 3600 } } as RequestInit);
  if (!res.ok) throw new Error(`wordpress.org plugin API failed: HTTP ${res.status}`);
  return normalize(await res.json());
}

export async function searchPlugins(
  q: string, page = 1, fetchImpl: typeof fetch = fetch,
): Promise<WpOrgSearchResult> {
  const params = new URLSearchParams();
  params.set("request[search]", q);
  params.set("request[page]", String(page));
  params.set("request[per_page]", "24");
  return query(params, fetchImpl);
}

export async function popularPlugins(
  page = 1, fetchImpl: typeof fetch = fetch,
): Promise<WpOrgSearchResult> {
  const params = new URLSearchParams();
  params.set("request[browse]", "popular");
  params.set("request[page]", String(page));
  params.set("request[per_page]", "24");
  return query(params, fetchImpl);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test` → green (79 + 5 new).

- [ ] **Step 5: Commit**

```powershell
git add src/lib/adapters/wporg.ts tests/wporg.test.ts; git commit -m "feat: wordpress.org plugin directory adapter"
```

---

### Task 2: Jobs batch support + storage migration (TDD)

**Files:**
- Create: `supabase/migrations/0003_storage_plugins.sql`
- Modify: `src/services/jobs/types.ts`, `src/services/jobs/repo.ts`, `src/services/jobs/service.ts`
- Test: `tests/jobs-batch.test.ts`

**Interfaces:**
- Produces:
```ts
// types.ts
export type JobType = "snapshot_refresh" | "security_scan" | "vuln_feed_refresh" | "plugin_install";

// repo.ts — JobsRepo.insert gains optional batch_id; new method:
insert(job: { type: JobType; site_id?: string | null; payload?: Record<string, unknown>; scheduled_for?: string; batch_id?: string | null }): Promise<{ id: string }>;
batchJobs(batchId: string): Promise<JobRow[]>;

// service.ts — new:
export async function enqueueBatch(
  repo: JobsRepo, type: JobType, siteIds: string[], payload: Record<string, unknown>,
): Promise<{ batchId: string; count: number }>;   // uuid via crypto.randomUUID
```

- [ ] **Step 1: Write the migration**

`supabase/migrations/0003_storage_plugins.sql`:
```sql
-- Private bucket for uploaded plugin ZIPs. Uploads happen via signed upload
-- URLs (server-issued), downloads via short-lived signed URLs — no public
-- access and no storage RLS policies needed for anon/authenticated roles.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('plugins', 'plugins', false, 52428800, array['application/zip', 'application/x-zip-compressed', 'application/octet-stream'])
on conflict (id) do nothing;
```

- [ ] **Step 2: Write the failing tests**

`tests/jobs-batch.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { enqueueBatch } from "@/services/jobs/service";
import type { JobsRepo } from "@/services/jobs/repo";
import type { JobRow, JobType } from "@/services/jobs/types";

function memoryRepo() {
  const rows: Array<JobRow & { batch_id: string | null }> = [];
  let seq = 0;
  const repo = {
    async insert(job: { type: JobType; site_id?: string | null; payload?: Record<string, unknown>; batch_id?: string | null }) {
      const id = `job-${++seq}`;
      rows.push({
        id, type: job.type, site_id: job.site_id ?? null, batch_id: job.batch_id ?? null,
        payload: job.payload ?? {}, status: "pending", attempts: 0,
        scheduled_for: new Date(0).toISOString(), last_error: null,
      });
      return { id };
    },
    async batchJobs(batchId: string) { return rows.filter((r) => r.batch_id === batchId); },
  } as unknown as JobsRepo;
  return { repo, rows };
}

describe("enqueueBatch", () => {
  it("inserts one job per site under a shared uuid batch id", async () => {
    const { repo, rows } = memoryRepo();
    const payload = { source: { kind: "wporg", slug: "akismet" }, activate: true };
    const res = await enqueueBatch(repo, "plugin_install", ["s1", "s2", "s3"], payload);
    expect(res.count).toBe(3);
    expect(res.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.batch_id))).toEqual(new Set([res.batchId]));
    expect(rows.map((r) => r.site_id)).toEqual(["s1", "s2", "s3"]);
    expect(rows[0].payload).toEqual(payload);
  });
  it("rejects an empty site list", async () => {
    const { repo } = memoryRepo();
    await expect(enqueueBatch(repo, "plugin_install", [], {})).rejects.toThrow(/at least one site/i);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- tests/jobs-batch.test.ts` → FAIL.

- [ ] **Step 4: Implement**

`src/services/jobs/types.ts` — extend the union:
```ts
export type JobType = "snapshot_refresh" | "security_scan" | "vuln_feed_refresh" | "plugin_install";
```

`src/services/jobs/repo.ts` — extend the interface `insert` signature (add `batch_id?: string | null` to the param object type) and add `batchJobs(batchId: string): Promise<JobRow[]>;`. In `supabaseJobsRepo`:
- in `insert`, include `...(job.batch_id ? { batch_id: job.batch_id } : {})` in the inserted row;
- add:
```ts
async batchJobs(batchId) {
  const { data, error } = await db.from("jobs").select("*")
    .eq("batch_id", batchId).order("scheduled_for");
  if (error) throw new Error(`jobs.batchJobs failed: ${error.message}`, { cause: error });
  return (data ?? []) as JobRow[];
},
```

`src/services/jobs/service.ts` — add:
```ts
import { randomUUID } from "node:crypto";

export async function enqueueBatch(
  repo: JobsRepo, type: JobType, siteIds: string[], payload: Record<string, unknown>,
): Promise<{ batchId: string; count: number }> {
  if (siteIds.length === 0) throw new Error("Select at least one site");
  const batchId = randomUUID();
  for (const siteId of siteIds) {
    await repo.insert({ type, site_id: siteId, payload, batch_id: batchId });
  }
  return { batchId, count: siteIds.length };
}
```

- [ ] **Step 5: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.

```powershell
git add supabase src/services/jobs tests/jobs-batch.test.ts; git commit -m "feat: job batches and plugins storage bucket"
```

---

### Task 3: Install service (TDD)

**Files:**
- Create: `src/services/marketplace/install.ts`
- Test: `tests/install.test.ts`

**Interfaces:**
- Consumes: `runPhp`, `phpString` (`@/lib/wpphp`); `SLUG_RE` (`@/services/manage/service`); `decryptSecret`; `McpFactory`; `SitesRepo`; `JobsRepo` + `enqueueJob`.
- Produces:
```ts
export type InstallSource = { kind: "wporg"; slug: string } | { kind: "url"; url: string };
export function buildInstallPhp(source: InstallSource, activate: boolean): string;  // throws on invalid slug/url
export interface InstallDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }
export async function installPlugin(
  deps: InstallDeps, siteId: string, actorId: string | null, source: InstallSource, activate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }>;
// actorId null => system/job execution: activity logged with actor "system" sentinel? NO —
// activity_log.actor is uuid not null; for job runs pass the batch creator's uid stored in payload.actor.
// installPlugin REQUIRES actorId: string (no null). Job payload carries actor.
```
(Final signature: `installPlugin(deps, siteId, actorId: string, source, activate)`; logs `site.plugin_install`, enqueues deduped `snapshot_refresh` on success — mirrors `manageSite`.)

- [ ] **Step 1: Write the failing tests**

`tests/install.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { buildInstallPhp, installPlugin } from "@/services/marketplace/install";
import type { InstallDeps } from "@/services/marketplace/install";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("buildInstallPhp", () => {
  it("builds a wp.org install with base64 slug and latest-stable zip", () => {
    const code = buildInstallPhp({ kind: "wporg", slug: "akismet" }, true);
    expect(code).toContain(`base64_decode('${b64("akismet")}')`);
    expect(code).toContain("downloads.wordpress.org/plugin/");
    expect(code).toContain("Plugin_Upgrader");
    expect(code).toContain("activate_plugin");
    expect(code).toContain("return json_encode");
  });
  it("omits activation when activate=false", () => {
    const code = buildInstallPhp({ kind: "wporg", slug: "akismet" }, false);
    expect(code).not.toContain("activate_plugin");
  });
  it("builds a URL install with the base64 URL embedded", () => {
    const url = "https://x.supabase.co/storage/v1/object/sign/plugins/u/a.zip?token=t";
    const code = buildInstallPhp({ kind: "url", url }, false);
    expect(code).toContain(`base64_decode('${b64(url)}')`);
    expect(code).not.toContain("token=t'"); // never raw
  });
  it("rejects bad slugs and non-https URLs", () => {
    expect(() => buildInstallPhp({ kind: "wporg", slug: "a;b" }, false)).toThrow(/invalid slug/i);
    expect(() => buildInstallPhp({ kind: "wporg", slug: "--flag" }, false)).toThrow(/invalid slug/i);
    expect(() => buildInstallPhp({ kind: "url", url: "http://insecure/x.zip" }, false)).toThrow(/https/i);
    expect(() => buildInstallPhp({ kind: "url", url: "ftp://x" }, false)).toThrow(/https/i);
  });
});

function phpResult(payload: unknown) {
  return { success: true, data: { success: true, return_value: JSON.stringify(payload), output: "", errors: [] } };
}

function fakeDeps(mock: MockMcpClient) {
  const activity: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let creds = "";
  const sites = {
    async getSiteCredentials(id: string) {
      return id === "site-1"
        ? { mcp_endpoint: "https://x/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: creds }
        : null;
    },
    async insertActivity(e: Record<string, unknown>) { activity.push(e); },
  } as unknown as SitesRepo;
  const jobs = {
    async pendingExists() { return false; },
    async insert(j: Record<string, unknown>) { enqueued.push(j); return { id: "j1" }; },
  } as unknown as JobsRepo;
  const deps: InstallDeps = { sites, jobs, mcp: async () => mock };
  return { deps, activity, enqueued, setCreds: (v: string) => { creds = v; } };
}

describe("installPlugin", () => {
  it("installs, logs activity, enqueues snapshot refresh", async () => {
    const mock = new MockMcpClient({
      handler: (name, args) => {
        expect(name).toBe("novamira/execute-php");
        expect((args as { code: string }).code).toContain("Plugin_Upgrader");
        return phpResult({ ok: true, message: "Installed and activated", file: "akismet/akismet.php" });
      },
    });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await installPlugin(f.deps, "site-1", "user-1", { kind: "wporg", slug: "akismet" }, true);
    expect(res).toMatchObject({ ok: true, output: "Installed and activated" });
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ actor: "user-1", site_id: "site-1", action: "site.plugin_install" });
    expect(f.enqueued[0]).toMatchObject({ type: "snapshot_refresh" });
  });
  it("surfaces failure without enqueueing refresh", async () => {
    const mock = new MockMcpClient({ handler: () => phpResult({ ok: false, error: "Download failed." }) });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await installPlugin(f.deps, "site-1", "user-1", { kind: "wporg", slug: "ghost" }, false);
    expect(res).toMatchObject({ ok: false, error: "Download failed." });
    expect(f.enqueued).toHaveLength(0);
    expect(f.activity[0]).toMatchObject({ action: "site.plugin_install" });
  });
  it("logs rejected invalid sources without opening a client", async () => {
    const mock = new MockMcpClient();
    const f = fakeDeps(mock);
    const res = await installPlugin(f.deps, "site-1", "user-1", { kind: "wporg", slug: "a;b" }, false);
    expect(res.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
    expect(f.activity[0]).toMatchObject({ action: "site.plugin_install" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/install.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/services/marketplace/install.ts`:
```ts
import { runPhp, phpString } from "@/lib/wpphp";
import { decryptSecret } from "@/lib/crypto/secrets";
import { SLUG_RE } from "@/services/manage/service";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";
import { enqueueJob } from "@/services/jobs/service";

export type InstallSource = { kind: "wporg"; slug: string } | { kind: "url"; url: string };

const INSTALL_TIMEOUT_MS = 300_000;

const PRELUDE = `
if (!function_exists('get_plugins')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/template.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
`;

export function buildInstallPhp(source: InstallSource, activate: boolean): string {
  let urlExpr: string;
  if (source.kind === "wporg") {
    if (!SLUG_RE.test(source.slug)) throw new Error(`Invalid slug: ${JSON.stringify(source.slug)}`);
    urlExpr = `'https://downloads.wordpress.org/plugin/' . rawurlencode(${phpString(source.slug)}) . '.latest-stable.zip'`;
  } else {
    if (!/^https:\/\//.test(source.url)) throw new Error("Install URL must be https");
    urlExpr = phpString(source.url);
  }
  const activatePhp = activate
    ? `
$file = $up->plugin_info();
if (!$file) { return json_encode(array('ok' => true, 'message' => 'Installed (activation skipped: main file unknown)')); }
$e = activate_plugin($file);
if (is_wp_error($e)) { return json_encode(array('ok' => false, 'error' => 'Installed but activation failed: ' . $e->get_error_message())); }
return json_encode(array('ok' => true, 'message' => 'Installed and activated', 'file' => $file));`
    : `
$file = $up->plugin_info();
return json_encode(array('ok' => true, 'message' => 'Installed', 'file' => $file));`;

  return `${PRELUDE}
$url = ${urlExpr};
$up = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$r = $up->install($url);
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) {
  $msgs = $up->skin->get_upgrade_messages();
  return json_encode(array('ok' => false, 'error' => 'Install failed: ' . (empty($msgs) ? 'download or filesystem error' : implode(' | ', array_slice($msgs, -3)))));
}
${activatePhp.trim()}`.trim();
}

export interface InstallDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }

export async function installPlugin(
  deps: InstallDeps, siteId: string, actorId: string,
  source: InstallSource, activate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const sourceSummary = source.kind === "wporg" ? { kind: source.kind, slug: source.slug } : { kind: source.kind };
  let code: string;
  try {
    code = buildInstallPhp(source, activate);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await deps.sites.insertActivity({
      actor: actorId, site_id: siteId, action: "site.plugin_install",
      detail: { source: sourceSummary, ok: false, error, rejected: "invalid_source" },
    });
    return { ok: false, error };
  }

  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) return { ok: false, error: "Site not found" };

  let output = "";
  let error: string | undefined;
  try {
    const client = await deps.mcp({
      endpoint: creds.mcp_endpoint,
      username: creds.wp_username,
      appPassword: await decryptSecret(creds.app_password_encrypted),
    });
    try {
      const result = await runPhp<{ ok: boolean; message?: string; error?: string }>(
        client, code, INSTALL_TIMEOUT_MS,
      );
      if (result.ok) output = result.message ?? "Installed";
      else error = result.error ?? "Install failed";
    } finally {
      await client.close();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: "site.plugin_install",
    detail: { source: sourceSummary, activate, ok: !error, ...(error ? { error } : { message: output }) },
  });
  if (!error) {
    await enqueueJob(deps.jobs, "snapshot_refresh", siteId, {}, { dedupe: true });
    return { ok: true, output };
  }
  return { ok: false, error };
}
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.

```powershell
git add src/services/marketplace tests/install.test.ts; git commit -m "feat: plugin install service via Plugin_Upgrader over execute-php"
```

---

### Task 4: Shared job handlers + batch status route

**Files:**
- Create: `src/services/jobs/handlers.ts`, `src/app/api/batches/[id]/route.ts`
- Modify: `src/app/api/cron/process/route.ts` (use the shared builder)

**Interfaces:**
- Consumes: everything above; `securityScan`, `refreshVulnFeed`, `refreshSnapshot`, repos, `createSiteMcpClient`, `installPlugin`, `InstallSource`, `createServerSupabase` (session check), `createServiceSupabase`.
- Produces:
```ts
// handlers.ts
export function buildJobHandlers(db: SupabaseClient): JobHandlers;
// covers: snapshot_refresh, security_scan, vuln_feed_refresh, plugin_install.
// plugin_install payload: { source: InstallSource | {kind:"upload", path:string}, activate: boolean, actor: string }
// {kind:"upload"} resolves a 1h signed URL from the "plugins" bucket at run time, then delegates to installPlugin with {kind:"url"}.

// GET /api/batches/[id] → 401 JSON without session; else
// { jobs: [{ id, site_id, site_name, status, attempts, last_error }] , done: boolean }
```

- [ ] **Step 1: Implement handlers**

`src/services/jobs/handlers.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobHandlers } from "@/services/jobs/service";
import { refreshSnapshot } from "@/services/inventory/service";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { securityScan, refreshVulnFeed } from "@/services/security/scan";
import { installPlugin, type InstallSource } from "@/services/marketplace/install";
import { createSiteMcpClient } from "@/lib/mcp/client";

interface PluginInstallPayload {
  source: InstallSource | { kind: "upload"; path: string };
  activate: boolean;
  actor: string;
}

export function buildJobHandlers(db: SupabaseClient): JobHandlers {
  const sites = supabaseSitesRepo(db);
  const snapshots = supabaseSnapshotsRepo(db);
  const security = supabaseSecurityRepo(db);
  const jobs = supabaseJobsRepo(db);

  return {
    snapshot_refresh: async ({ job }) => {
      if (!job.site_id) throw new Error("snapshot_refresh requires site_id");
      await refreshSnapshot({ sites, snapshots, mcp: createSiteMcpClient }, job.site_id);
    },
    security_scan: async ({ job }) => {
      if (!job.site_id) throw new Error("security_scan requires site_id");
      await securityScan({ sites, snapshots, security, mcp: createSiteMcpClient }, job.site_id);
    },
    vuln_feed_refresh: async () => {
      await refreshVulnFeed(security);
    },
    plugin_install: async ({ job }) => {
      if (!job.site_id) throw new Error("plugin_install requires site_id");
      const p = job.payload as unknown as PluginInstallPayload;
      if (!p?.source || typeof p.actor !== "string") throw new Error("plugin_install payload malformed");
      let source: InstallSource;
      if (p.source.kind === "upload") {
        const { data, error } = await db.storage.from("plugins").createSignedUrl(p.source.path, 3600);
        if (error || !data?.signedUrl) {
          throw new Error(`Could not sign uploaded plugin URL: ${error?.message ?? "unknown"}`);
        }
        source = { kind: "url", url: data.signedUrl };
      } else {
        source = p.source;
      }
      const result = await installPlugin(
        { sites, jobs, mcp: createSiteMcpClient }, job.site_id, p.actor, source, Boolean(p.activate),
      );
      if (!result.ok) throw new Error(result.error ?? "Install failed");
    },
  };
}
```

- [ ] **Step 2: Refactor the process route**

`src/app/api/cron/process/route.ts` — replace the inline `handlers` construction with:
```ts
import { buildJobHandlers } from "@/services/jobs/handlers";
// inside run():
const result = await processJobs(supabaseJobsRepo(db), buildJobHandlers(db), { max: 3 });
```
Remove the now-unused imports (`refreshSnapshot`, `supabaseSnapshotsRepo`, `supabaseSitesRepo`, `securityScan`, `refreshVulnFeed`, `supabaseSecurityRepo`, `createSiteMcpClient`, `JobHandlers` type) — keep `processJobs`, `supabaseJobsRepo`, `isAuthorizedCronRequest`, `createServiceSupabase`, `NextResponse`.

- [ ] **Step 3: Implement the batch status route**

`src/app/api/batches/[id]/route.ts`:
```ts
import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "invalid batch id" }, { status: 400 });
  }
  const db = createServiceSupabase();
  const [jobs, sites] = await Promise.all([
    supabaseJobsRepo(db).batchJobs(id),
    supabaseSitesRepo(db).listSites(),
  ]);
  const names = new Map(sites.map((s) => [s.id, s.name]));
  const rows = jobs.map((j) => ({
    id: j.id,
    site_id: j.site_id,
    site_name: j.site_id ? names.get(j.site_id) ?? j.site_id : "—",
    status: j.status,
    attempts: j.attempts,
    last_error: j.last_error,
  }));
  const done = rows.length > 0 && rows.every((r) => r.status === "done" || r.status === "failed");
  return NextResponse.json({ jobs: rows, done });
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — all green.

```powershell
git add src/services/jobs/handlers.ts src/app/api; git commit -m "feat: shared job handlers with plugin_install and batch status API"
```

---

### Task 5: Child theme service (TDD)

**Files:**
- Create: `src/services/childtheme/service.ts`
- Test: `tests/childtheme.test.ts`

**Interfaces:**
- Consumes: `runPhp`, `decryptSecret`, `McpFactory`, `SitesRepo`, `JobsRepo`, `enqueueJob`.
- Produces:
```ts
export function buildChildThemePhp(activate: boolean): string;  // pure — no untrusted inputs at all
export interface ChildThemeDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }
export async function createChildTheme(
  deps: ChildThemeDeps, siteId: string, actorId: string, activate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }>;   // logs site.child_theme; snapshot refresh on success
```

- [ ] **Step 1: Write the failing tests**

`tests/childtheme.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { buildChildThemePhp, createChildTheme } from "@/services/childtheme/service";
import type { ChildThemeDeps } from "@/services/childtheme/service";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("buildChildThemePhp", () => {
  it("guards against child-of-child and existing directories, writes both files", () => {
    const code = buildChildThemePhp(false);
    expect(code).toContain("get_template()");
    expect(code).toContain("get_stylesheet()");
    expect(code).toContain("already a child theme");
    expect(code).toContain("file_exists($dir)");
    expect(code).toContain("style.css");
    expect(code).toContain("functions.php");
    expect(code).toContain("Template: ");
    expect(code).toContain("return json_encode");
    expect(code).not.toContain("switch_theme");
  });
  it("activates via switch_theme when requested", () => {
    expect(buildChildThemePhp(true)).toContain("switch_theme");
  });
});

function phpResult(payload: unknown) {
  return { success: true, data: { success: true, return_value: JSON.stringify(payload), output: "", errors: [] } };
}

function fakeDeps(mock: MockMcpClient) {
  const activity: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let creds = "";
  const sites = {
    async getSiteCredentials(id: string) {
      return id === "site-1"
        ? { mcp_endpoint: "https://x/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: creds }
        : null;
    },
    async insertActivity(e: Record<string, unknown>) { activity.push(e); },
  } as unknown as SitesRepo;
  const jobs = {
    async pendingExists() { return false; },
    async insert(j: Record<string, unknown>) { enqueued.push(j); return { id: "j1" }; },
  } as unknown as JobsRepo;
  const deps: ChildThemeDeps = { sites, jobs, mcp: async () => mock };
  return { deps, activity, enqueued, setCreds: (v: string) => { creds = v; } };
}

describe("createChildTheme", () => {
  it("creates, logs, and enqueues snapshot refresh", async () => {
    const mock = new MockMcpClient({
      handler: () => phpResult({ ok: true, message: "Child theme generatepress-child created" }),
    });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await createChildTheme(f.deps, "site-1", "user-1", true);
    expect(res.ok).toBe(true);
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ actor: "user-1", action: "site.child_theme" });
    expect(f.enqueued[0]).toMatchObject({ type: "snapshot_refresh" });
  });
  it("surfaces guard failures without refresh", async () => {
    const mock = new MockMcpClient({
      handler: () => phpResult({ ok: false, error: "Active theme is already a child theme (gp-child)" }),
    });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await createChildTheme(f.deps, "site-1", "user-1", false);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("already a child") });
    expect(f.enqueued).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/childtheme.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/services/childtheme/service.ts`:
```ts
import { runPhp } from "@/lib/wpphp";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";
import { enqueueJob } from "@/services/jobs/service";

// No untrusted values: the parent slug is discovered inside WordPress.
export function buildChildThemePhp(activate: boolean): string {
  return `
$parent = get_template();
$current = get_stylesheet();
if ($parent !== $current) { return json_encode(array('ok' => false, 'error' => 'Active theme is already a child theme (' . $current . ')')); }
$slug = $parent . '-child';
$dir = get_theme_root() . '/' . $slug;
if (file_exists($dir)) { return json_encode(array('ok' => false, 'error' => 'Child theme directory already exists: ' . $slug)); }
if (!wp_mkdir_p($dir)) { return json_encode(array('ok' => false, 'error' => 'Could not create theme directory')); }
$theme = wp_get_theme($parent);
$style = "/*\\n" . 'Theme Name: ' . $theme->get('Name') . " Child\\n" . 'Template: ' . $parent . "\\n" . "Version: 1.0.0\\n" . "*/\\n";
if (file_put_contents($dir . '/style.css', $style) === false) { return json_encode(array('ok' => false, 'error' => 'Could not write style.css')); }
$fn = "<?php\\n" . "add_action('wp_enqueue_scripts', function () {\\n" . "  wp_enqueue_style('parent-style', get_template_directory_uri() . '/style.css');\\n" . "});\\n";
if (file_put_contents($dir . '/functions.php', $fn) === false) { return json_encode(array('ok' => false, 'error' => 'Could not write functions.php')); }
${activate ? "switch_theme($slug);" : ""}
return json_encode(array('ok' => true, 'message' => 'Child theme ' . $slug . ' created${activate ? " and activated" : ""}'));
`.trim();
}

export interface ChildThemeDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }

export async function createChildTheme(
  deps: ChildThemeDeps, siteId: string, actorId: string, activate: boolean,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) return { ok: false, error: "Site not found" };

  let output = "";
  let error: string | undefined;
  try {
    const client = await deps.mcp({
      endpoint: creds.mcp_endpoint,
      username: creds.wp_username,
      appPassword: await decryptSecret(creds.app_password_encrypted),
    });
    try {
      const result = await runPhp<{ ok: boolean; message?: string; error?: string }>(
        client, buildChildThemePhp(activate), 60_000,
      );
      if (result.ok) output = result.message ?? "Child theme created";
      else error = result.error ?? "Child theme creation failed";
    } finally {
      await client.close();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: "site.child_theme",
    detail: { activate, ok: !error, ...(error ? { error } : { message: output }) },
  });
  if (!error) {
    await enqueueJob(deps.jobs, "snapshot_refresh", siteId, {}, { dedupe: true });
    return { ok: true, output };
  }
  return { ok: false, error };
}
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `npm test` → green; `npx tsc --noEmit` → 0 errors.

```powershell
git add src/services/childtheme tests/childtheme.test.ts; git commit -m "feat: child theme installer service"
```

---

### Task 6: Marketplace server actions + upload prep

**Files:**
- Create: `src/app/(dashboard)/marketplace/actions.ts`, `src/app/(dashboard)/sites/[id]/child-theme-actions.ts`

**Interfaces:**
- Consumes: `installPlugin`, `enqueueBatch`, `buildJobHandlers`, `processJobs`, `createChildTheme`, repos, `requireUser`, `createServiceSupabase`, `SLUG_RE`.
- Produces:
```ts
// marketplace/actions.ts ("use server")
export async function createInstallBatchAction(input: {
  source: { kind: "wporg"; slug: string } | { kind: "upload"; path: string };
  siteIds: string[]; activate: boolean;
}): Promise<{ ok: boolean; batchId?: string; error?: string }>;
export async function prepareUploadAction(filename: string): Promise<{ ok: boolean; path?: string; token?: string; error?: string }>;
export async function processQueueNowAction(): Promise<{ ok: boolean; done?: number; failed?: number; error?: string }>;

// sites/[id]/child-theme-actions.ts ("use server")
export async function createChildThemeAction(siteId: string, activate: boolean): Promise<{ ok: boolean; error?: string }>;
```

- [ ] **Step 1: Implement marketplace actions**

`src/app/(dashboard)/marketplace/actions.ts`:
```ts
"use server";

import { randomUUID } from "node:crypto";
import { enqueueBatch, processJobs } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { buildJobHandlers } from "@/services/jobs/handlers";
import { SLUG_RE } from "@/services/manage/service";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

export async function createInstallBatchAction(input: {
  source: { kind: "wporg"; slug: string } | { kind: "upload"; path: string };
  siteIds: string[];
  activate: boolean;
}): Promise<{ ok: boolean; batchId?: string; error?: string }> {
  const user = await requireUser();
  if (!Array.isArray(input.siteIds) || input.siteIds.length === 0) {
    return { ok: false, error: "Select at least one site" };
  }
  if (input.source.kind === "wporg" && !SLUG_RE.test(input.source.slug)) {
    return { ok: false, error: "Invalid plugin slug" };
  }
  if (input.source.kind === "upload" && !/^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+\.zip$/i.test(input.source.path)) {
    return { ok: false, error: "Invalid upload path" };
  }
  const db = createServiceSupabase();
  try {
    const { batchId } = await enqueueBatch(supabaseJobsRepo(db), "plugin_install", input.siteIds, {
      source: input.source, activate: Boolean(input.activate), actor: user.id,
    });
    return { ok: true, batchId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not create batch" };
  }
}

export async function prepareUploadAction(
  filename: string,
): Promise<{ ok: boolean; path?: string; token?: string; error?: string }> {
  await requireUser();
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!/\.zip$/i.test(safe)) return { ok: false, error: "Only .zip files are supported" };
  const path = `uploads/${randomUUID()}/${safe}`;
  const db = createServiceSupabase();
  const { data, error } = await db.storage.from("plugins").createSignedUploadUrl(path);
  if (error || !data?.token) {
    return { ok: false, error: `Could not prepare upload: ${error?.message ?? "unknown"}` };
  }
  return { ok: true, path, token: data.token };
}

export async function processQueueNowAction(): Promise<{
  ok: boolean; done?: number; failed?: number; error?: string;
}> {
  await requireUser();
  const db = createServiceSupabase();
  try {
    const res = await processJobs(supabaseJobsRepo(db), buildJobHandlers(db), { max: 3 });
    return { ok: true, done: res.done, failed: res.failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Queue processing failed" };
  }
}
```

- [ ] **Step 2: Implement the child theme action**

`src/app/(dashboard)/sites/[id]/child-theme-actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { createChildTheme } from "@/services/childtheme/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

export async function createChildThemeAction(
  siteId: string, activate: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const db = createServiceSupabase();
  const result = await createChildTheme(
    { sites: supabaseSitesRepo(db), jobs: supabaseJobsRepo(db), mcp: createSiteMcpClient },
    siteId, user.id, activate,
  );
  revalidatePath(`/sites/${siteId}/themes`);
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — green.

```powershell
git add "src/app/(dashboard)/marketplace/actions.ts" "src/app/(dashboard)/sites/[id]/child-theme-actions.ts"; git commit -m "feat: marketplace and child theme server actions"
```

---

### Task 7: Marketplace UI (page, install panel, upload card, nav)

**Files:**
- Create: `src/app/(dashboard)/marketplace/page.tsx`, `src/app/(dashboard)/marketplace/install-panel.tsx`, `src/app/(dashboard)/marketplace/upload-card.tsx`
- Modify: `src/app/(dashboard)/layout.tsx` (nav link), `src/app/(dashboard)/sites/[id]/plugins/page.tsx` (link)

**Interfaces:**
- Consumes: `searchPlugins`/`popularPlugins` (Task 1), actions (Task 6), `createBrowserSupabase` (Phase 1), `listSites`/repos.
- Produces: route `/marketplace?q=...`; `InstallPanel({ slug, sites })`, `UploadCard({ sites })` client components (sites: `Array<{ id: string; name: string }>`).

- [ ] **Step 1: Implement InstallPanel (client)**

`src/app/(dashboard)/marketplace/install-panel.tsx`:
```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInstallBatchAction } from "./actions";

export interface SiteOption { id: string; name: string }

export function InstallPanel({ slug, sites }: { slug: string; sites: SiteOption[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activate, setActivate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await createInstallBatchAction({
        source: { kind: "wporg", slug }, siteIds: [...selected], activate,
      });
      if (res.ok && res.batchId) router.push(`/marketplace/batches/${res.batchId}`);
      else setError(res.error ?? "Failed to start install");
    });
  };

  return (
    <details className="mt-2">
      <summary className="min-h-10 cursor-pointer rounded bg-slate-900 px-3 py-2 text-center text-sm text-white">
        Install…
      </summary>
      <div className="mt-2 space-y-2 rounded border bg-slate-50 p-3 text-sm">
        <p className="font-medium">Install on:</p>
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {sites.map((s) => (
            <label key={s.id} className="flex min-h-10 items-center gap-2">
              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
              <span className="truncate">{s.name}</span>
            </label>
          ))}
        </div>
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          Activate after install
        </label>
        <button onClick={submit} disabled={pending || selected.size === 0}
          className="min-h-10 w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50">
          {pending ? "Starting…" : `Install on ${selected.size} site(s)`}
        </button>
        <p aria-live="polite" className="min-h-4 text-xs text-red-600">{error}</p>
      </div>
    </details>
  );
}
```

- [ ] **Step 2: Implement UploadCard (client)**

`src/app/(dashboard)/marketplace/upload-card.tsx`:
```tsx
"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { createInstallBatchAction, prepareUploadAction } from "./actions";
import type { SiteOption } from "./install-panel";

const MAX_BYTES = 50 * 1024 * 1024;

export function UploadCard({ sites }: { sites: SiteOption[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activate, setActivate] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const submit = () => {
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) { setError("Choose a plugin .zip file first"); return; }
    if (!/\.zip$/i.test(file.name)) { setError("Only .zip files are supported"); return; }
    if (file.size > MAX_BYTES) { setError("File exceeds the 50MB limit"); return; }
    if (selected.size === 0) { setError("Select at least one site"); return; }

    startTransition(async () => {
      setStatus("Preparing upload…");
      const prep = await prepareUploadAction(file.name);
      if (!prep.ok || !prep.path || !prep.token) {
        setError(prep.error ?? "Upload preparation failed"); setStatus(null); return;
      }
      setStatus("Uploading…");
      const supabase = createBrowserSupabase();
      const { error: upErr } = await supabase.storage
        .from("plugins").uploadToSignedUrl(prep.path, prep.token, file);
      if (upErr) { setError(`Upload failed: ${upErr.message}`); setStatus(null); return; }
      setStatus("Starting installs…");
      const res = await createInstallBatchAction({
        source: { kind: "upload", path: prep.path }, siteIds: [...selected], activate,
      });
      if (res.ok && res.batchId) router.push(`/marketplace/batches/${res.batchId}`);
      else { setError(res.error ?? "Failed to start install"); setStatus(null); }
    });
  };

  return (
    <section className="rounded-lg border bg-white p-4 shadow-sm">
      <h2 className="mb-2 font-medium">Upload a plugin</h2>
      <p className="mb-3 text-xs text-slate-500">
        Upload a plugin .zip (e.g. a premium plugin) and install it on selected sites.
      </p>
      <div className="space-y-2 text-sm">
        <label className="block">
          <span className="sr-only">Plugin zip file</span>
          <input ref={fileRef} type="file" accept=".zip,application/zip"
            className="block w-full text-sm file:mr-3 file:min-h-10 file:rounded file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-white" />
        </label>
        <div className="max-h-32 space-y-1 overflow-y-auto">
          {sites.map((s) => (
            <label key={s.id} className="flex min-h-10 items-center gap-2">
              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
              <span className="truncate">{s.name}</span>
            </label>
          ))}
        </div>
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          Activate after install
        </label>
        <button onClick={submit} disabled={pending}
          className="min-h-10 w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50">
          {pending ? (status ?? "Working…") : "Upload & install"}
        </button>
        <p aria-live="polite" className="min-h-4 text-xs text-red-600">{error}</p>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Implement the Marketplace page**

`src/app/(dashboard)/marketplace/page.tsx`:
```tsx
import { searchPlugins, popularPlugins, type WpOrgSearchResult } from "@/lib/adapters/wporg";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { InstallPanel } from "./install-panel";
import { UploadCard } from "./upload-card";

export const dynamic = "force-dynamic";

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M+`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K+`;
  return String(n);
}

export default async function MarketplacePage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const db = createServiceSupabase();
  const sites = (await listSites({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }))
    .filter((s) => s.status !== "disabled")
    .map((s) => ({ id: s.id, name: s.name }));

  let results: WpOrgSearchResult | null = null;
  let searchError: string | null = null;
  try {
    results = q ? await searchPlugins(q) : await popularPlugins();
  } catch (e) {
    searchError = e instanceof Error ? e.message : "wordpress.org search failed";
  }

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <h1 className="mb-4 text-2xl font-semibold">Marketplace</h1>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <form action="/marketplace" method="get" className="lg:col-span-2">
          <label htmlFor="q" className="mb-1 block text-sm font-medium">
            Search wordpress.org plugins
          </label>
          <div className="flex gap-2">
            <input id="q" name="q" defaultValue={q ?? ""} placeholder="e.g. caching, seo, forms"
              className="min-h-10 w-full rounded border px-3 py-2" />
            <button className="min-h-10 shrink-0 rounded bg-slate-900 px-4 py-2 text-sm text-white">
              Search
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {q ? `Results for "${q}"` : "Popular plugins"}
            {results ? ` · ${results.total} found` : ""}
          </p>
        </form>
        <UploadCard sites={sites} />
      </div>

      {searchError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          wordpress.org is unavailable right now: {searchError}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {results!.plugins.map((p) => (
            <div key={p.slug} className="flex flex-col rounded-lg border bg-white p-4 shadow-sm">
              <div className="flex items-start gap-3">
                {p.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.icon} alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded" />
                ) : (
                  <div aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-slate-200 text-lg font-semibold text-slate-500">
                    {p.name.charAt(0)}
                  </div>
                )}
                <div className="min-w-0">
                  <h2 className="truncate font-medium" title={p.name}>{p.name}</h2>
                  <p className="truncate text-xs text-slate-500">by {p.author} · v{p.version}</p>
                </div>
              </div>
              <p className="mt-2 line-clamp-2 flex-1 text-sm text-slate-600">{p.short_description}</p>
              <p className="mt-2 text-xs text-slate-500">
                ★ {p.rating > 0 ? `${Math.round(p.rating)}%` : "—"} ({p.num_ratings}) · {formatInstalls(p.active_installs)} installs
              </p>
              <InstallPanel slug={p.slug} sites={sites} />
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Nav link + plugins tab link**

In `src/app/(dashboard)/layout.tsx`, inside the `<nav>` after the "+ Connect site" link add:
```tsx
<Link href="/marketplace" className="py-2 text-sm text-slate-600 hover:text-slate-900">
  Marketplace
</Link>
```

In `src/app/(dashboard)/sites/[id]/plugins/page.tsx`, in the toolbar `<div className="flex flex-wrap gap-2">` (next to Refresh inventory), add as the first child:
```tsx
<a href="/marketplace" className="min-h-10 rounded border px-3 py-2 text-sm hover:bg-slate-100">
  Install new plugin
</a>
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — green.

```powershell
git add "src/app/(dashboard)"; git commit -m "feat: marketplace page with search, install panel, and plugin upload"
```

---

### Task 8: Batch progress page + child theme UI + README

**Files:**
- Create: `src/app/(dashboard)/marketplace/batches/[id]/page.tsx`, `src/app/(dashboard)/marketplace/batches/[id]/poller.tsx`
- Modify: `src/app/(dashboard)/sites/[id]/themes/page.tsx` (child theme card), `README.md`

**Interfaces:**
- Consumes: `/api/batches/[id]` (Task 4), `processQueueNowAction` (Task 6), `createChildThemeAction` (Task 6), `ManageForm` pattern.
- Produces: route `/marketplace/batches/[id]`; child theme card on Themes tab.

- [ ] **Step 1: Implement the poller (client)**

`src/app/(dashboard)/marketplace/batches/[id]/poller.tsx`:
```tsx
"use client";

import { useEffect, useState, useTransition } from "react";
import { processQueueNowAction } from "../../actions";

interface BatchJob {
  id: string; site_id: string | null; site_name: string;
  status: string; attempts: number; last_error: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-slate-200 text-slate-600",
  running: "bg-blue-100 text-blue-800",
  awaiting_callback: "bg-blue-100 text-blue-800",
  done: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export function BatchPoller({ batchId }: { batchId: string }) {
  const [jobs, setJobs] = useState<BatchJob[] | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch(`/api/batches/${batchId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { jobs: BatchJob[]; done: boolean };
        if (stop) return;
        setJobs(data.jobs);
        setDone(data.done);
        setError(null);
        if (!data.done) timer = setTimeout(poll, 4000);
      } catch (e) {
        if (stop) return;
        setError(e instanceof Error ? e.message : "Polling failed");
        timer = setTimeout(poll, 8000);
      }
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [batchId]);

  const processNow = () => {
    startTransition(async () => { await processQueueNowAction(); });
  };

  if (!jobs) return <p className="text-sm text-slate-500">Loading batch…</p>;

  const doneCount = jobs.filter((j) => j.status === "done").length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600" aria-live="polite">
          {done
            ? `Finished: ${doneCount} succeeded, ${failedCount} failed.`
            : `In progress — ${doneCount + failedCount}/${jobs.length} finished. The queue runs every minute.`}
        </p>
        {!done && (
          <button onClick={processNow} disabled={pending}
            className="min-h-10 rounded border px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50">
            {pending ? "Processing…" : "Process queue now"}
          </button>
        )}
      </div>
      {error && <p className="mb-2 text-xs text-red-600">Refresh issue: {error} (retrying)</p>}
      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Site</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-b last:border-0">
                <td className="px-4 py-2 font-medium">{j.site_name}</td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[j.status] ?? STATUS_STYLE.pending}`}>
                    {j.status.replace("_", " ")}
                  </span>
                </td>
                <td className="px-4 py-2">{j.attempts}</td>
                <td className="max-w-64 truncate px-4 py-2 text-xs text-red-600" title={j.last_error ?? undefined}>
                  {j.last_error ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement the batch page**

`src/app/(dashboard)/marketplace/batches/[id]/page.tsx`:
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchPoller } from "./poller";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Install batch</h1>
        <Link href="/marketplace" className="min-h-10 rounded border px-3 py-2 text-sm hover:bg-slate-100">
          ← Marketplace
        </Link>
      </div>
      <p className="mb-6 break-all text-xs text-slate-400">{id}</p>
      <BatchPoller batchId={id} />
    </main>
  );
}
```

- [ ] **Step 3: Child theme card on the Themes tab**

In `src/app/(dashboard)/sites/[id]/themes/page.tsx`:
- Add imports:
```tsx
import { ManageForm, type ManageFormAction } from "../action-form";   // ManageForm already imported — keep single import
import { createChildThemeAction } from "../child-theme-actions";
```
- Below the themes table, add:
```tsx
      <section className="mt-6 rounded-lg border bg-white p-4 shadow-sm">
        <h2 className="mb-1 font-medium">Child theme</h2>
        <p className="mb-3 text-xs text-slate-500">
          Generate a child theme of the active theme (style.css + functions.php with the parent
          stylesheet enqueued). Safe to run: refuses if the active theme is already a child.
        </p>
        <div className="flex flex-wrap gap-2">
          <ManageForm action={createChild} label="Create child theme" pendingLabel="Creating…"
            confirmMessage={`Create a child theme of the active theme on ${site.name}?`} />
          <ManageForm action={createAndActivate} label="Create + activate" pendingLabel="Creating…"
            confirmMessage={`Create AND ACTIVATE a child theme on ${site.name}? The site will switch themes.`}
            buttonClassName="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" />
        </div>
      </section>
```
- Add the bound actions next to the existing `refresh` binding:
```tsx
  const createChild = createChildThemeAction.bind(null, id, false) as unknown as ManageFormAction;
  const createAndActivate = createChildThemeAction.bind(null, id, true) as unknown as ManageFormAction;
```

- [ ] **Step 4: README**

In `README.md`, after the "Background jobs" section add:
```markdown
## Marketplace

`/marketplace` searches wordpress.org, installs plugins on one or many sites
(bulk installs run as a job batch with a live progress page), and accepts
uploaded plugin ZIPs (stored in the private `plugins` Supabase Storage bucket —
created by migration 0003). The Themes tab can generate a child theme of the
active theme.
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — green.

```powershell
git add "src/app/(dashboard)" README.md; git commit -m "feat: batch progress page and child theme installer UI"
```

---

## Self-Review Notes

- **Spec §6.5 coverage:** wp.org search/browse with ratings/installs/icons (T1, T7), install+activate single site (bulk of one) and bulk with per-site progress via batch_id polling (T2-T4, T7-T8), upload custom plugin → storage → install on N sites (T2, T4, T6, T7). Spec's `create-upload-link` streaming path replaced by signed-URL install (§3.1 execute-php amendment makes `Plugin_Upgrader->install(url)` the uniform mechanism — simpler and identical for wp.org and uploads; noted as a deliberate deviation to record in the spec after merge). §6.6 child theme (T5, T6, T8) with both guardrails.
- **Type consistency:** `InstallSource` (T3) consumed by handlers (T4) and actions (T6); `SiteOption` shared by both client components; `enqueueBatch`/`batchJobs` (T2) used by T4/T6; `buildJobHandlers` used by cron route and `processQueueNowAction`.
- **Judgment calls:** installs are not deduped (reinstall is legitimate); batch jobs carry `actor` in payload so job-executed installs still activity-log the initiating user; `plugin_install` handler throws on `result.ok === false` so failures surface in `jobs.last_error` and the batch page.
