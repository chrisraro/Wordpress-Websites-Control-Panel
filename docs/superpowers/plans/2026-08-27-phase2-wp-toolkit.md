# Phase 2: WP Toolkit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the connected-sites dashboard into a working WP Toolkit: nightly inventory snapshots, a durable jobs queue with cron processing, and plugin/theme/core management actions with Plugins/Themes tabs.

**Architecture:** The `jobs` table (created in Phase 1) becomes a real queue: a Postgres `claim_jobs` function (FOR UPDATE SKIP LOCKED) is called via RPC by `/api/cron/process`; `/api/cron/enqueue` fans out per-site `snapshot_refresh` jobs. Inventory is collected over MCP with WP-CLI commands and stored in `site_snapshots`; all UI reads snapshots, never live MCP. Management actions build validated WP-CLI commands, run them with a long per-call timeout, log to `activity_log`, and enqueue a snapshot refresh.

**Tech Stack:** Existing Phase 1 stack. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md`. Phase 1 interfaces are in `src/lib/*` and `src/services/sites/*` — consume them, do not modify them except where a task explicitly says so.
- All MCP calls server-side only; credentials decrypted transiently; never in client components or serialized props.
- Every mutating action inserts an `activity_log` row (action names in this plan: `site.manage.<kind>`, `job.enqueue` is NOT logged — only user-initiated mutations are).
- Jobs: idempotent; max 3 attempts; backoff after failure — attempt 1 → retry in 60s, attempt 2 → retry in 300s, attempt 3 → status `failed`. One code path for scheduled and manual work.
- Cron routes accept POST and GET, authorized by `x-cron-secret: <CRON_SECRET>` header OR `Authorization: Bearer <CRON_SECRET>`; reject others with 401. `CRON_SECRET` is a required env var.
- WP-CLI slugs must match `/^[a-z0-9._-]+$/i` before being interpolated into any command — reject otherwise (command injection guard).
- Long-running WP-CLI calls (updates) use a 180s per-call timeout; inventory reads use 60s.
- Responsive design mandatory (mobile-first Tailwind; tables scroll inside `overflow-x-auto` containers; tap targets ≥ 40px). Destructive/mutating buttons require a confirm dialog. An impeccable audit runs after the UI tasks (orchestrator-level, after Task 9).
- Site status enum unchanged: `connected | degraded | reconnect_needed | disabled`.
- Commit after every task. Windows/PowerShell-safe commands (no `&&` in PowerShell).

## File Structure (new/changed in Phase 2)

```
supabase/migrations/0002_jobs_claim.sql       # claim_jobs() RPC
docs/ops/scheduling.md                        # pg_cron + pg_net setup template (user applies)
vercel.json                                   # daily enqueue backstop cron
src/lib/env.ts                                # + CRON_SECRET
src/lib/cron-auth.ts                          # cron request authorization
src/lib/mcp/client.ts                         # executeAbility gains per-call timeout opt
src/lib/mcp/mock.ts                           # + handler config for command-aware mocking
src/lib/wpcli.ts                              # runWpCli, parseWpCliResult, parseJsonArray
src/services/jobs/{types,repo,service}.ts     # queue: enqueue/claim/complete/backoff/dispatch
src/services/inventory/{types,repo,service}.ts# collectInventory, refreshSnapshot, pendingUpdates
src/services/manage/{types,service}.ts        # buildCommands + manageSite
src/app/api/cron/process/route.ts             # claims & runs jobs
src/app/api/cron/enqueue/route.ts             # nightly fan-out
src/app/(dashboard)/sites/[id]/tabs.tsx       # shared SiteTabs component (links)
src/app/(dashboard)/sites/[id]/page.tsx       # overview: uses SiteTabs, core banner, tools card, admins
src/app/(dashboard)/sites/[id]/manage-actions.ts # server actions for manage + refresh
src/app/(dashboard)/sites/[id]/confirm-button.tsx # client confirm submit button
src/app/(dashboard)/sites/[id]/plugins/page.tsx
src/app/(dashboard)/sites/[id]/themes/page.tsx
src/app/(dashboard)/dashboard/page.tsx        # + pending updates count per card
tests/{jobs-service,wpcli,inventory,manage}.test.ts
```

---

### Task 1: claim_jobs migration + CRON_SECRET plumbing

**Files:**
- Create: `supabase/migrations/0002_jobs_claim.sql`
- Modify: `src/lib/env.ts` (add name), `.env.example` (add var)

**Interfaces:**
- Consumes: `jobs` table from `supabase/migrations/0001_init.sql`.
- Produces: Postgres function `claim_jobs(batch_size int) returns setof jobs` (callable via supabase `.rpc("claim_jobs", { batch_size })` with the service-role client); `getEnv("CRON_SECRET")`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0002_jobs_claim.sql`:
```sql
-- Atomically claim up to batch_size due pending jobs.
-- SKIP LOCKED makes concurrent processors safe; attempts increments on claim.
create or replace function claim_jobs(batch_size int)
returns setof jobs
language sql
security definer
set search_path = public
as $$
  update jobs
  set status = 'running', started_at = now(), attempts = attempts + 1
  where id in (
    select id from jobs
    where status = 'pending' and scheduled_for <= now()
    order by scheduled_for
    limit batch_size
    for update skip locked
  )
  returning *;
$$;

revoke execute on function claim_jobs(int) from public, anon, authenticated;
grant execute on function claim_jobs(int) to service_role;
```

- [ ] **Step 2: Add CRON_SECRET to env plumbing**

In `src/lib/env.ts`, extend the NAMES tuple:
```ts
const NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_ENCRYPTION_KEY",
  "CRON_SECRET",
] as const;
```

Append to `.env.example`:
```
# shared secret for /api/cron/* routes; generate like APP_ENCRYPTION_KEY
CRON_SECRET=
```

- [ ] **Step 3: Verify and apply**

Run: `npx tsc --noEmit` → 0 errors; `npm test` → all existing tests green.
Apply the migration to Supabase (`npx supabase db push` or dashboard SQL editor) — if no CLI/project access in this environment, note it as pending user action.

- [ ] **Step 4: Commit**

```powershell
git add supabase src/lib/env.ts .env.example; git commit -m "feat: claim_jobs RPC and CRON_SECRET env"
```

---

### Task 2: Jobs service (TDD)

**Files:**
- Create: `src/services/jobs/types.ts`, `src/services/jobs/repo.ts`, `src/services/jobs/service.ts`
- Test: `tests/jobs-service.test.ts`

**Interfaces:**
- Consumes: `SupabaseClient` (service role).
- Produces:

```ts
// types.ts
export type JobType = "snapshot_refresh";            // extended in later phases
export type JobStatus = "pending" | "running" | "awaiting_callback" | "done" | "failed";
export interface JobRow {
  id: string; type: JobType; site_id: string | null; batch_id: string | null;
  payload: Record<string, unknown>; status: JobStatus; attempts: number;
  scheduled_for: string; last_error: string | null;
}

// repo.ts
export interface JobsRepo {
  insert(job: { type: JobType; site_id?: string | null; payload?: Record<string, unknown>; scheduled_for?: string }): Promise<{ id: string }>;
  pendingExists(type: JobType, siteId: string | null): Promise<boolean>;
  claim(batchSize: number): Promise<JobRow[]>;
  markDone(id: string): Promise<void>;
  retry(id: string, error: string, retryAtIso: string): Promise<void>;   // -> pending, scheduled_for=retryAt
  markFailed(id: string, error: string): Promise<void>;                  // -> failed
}
export function supabaseJobsRepo(db: SupabaseClient): JobsRepo;

// service.ts
export interface JobContext { job: JobRow }
export type JobHandler = (ctx: JobContext) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;
export function computeRetryDelayMs(attemptsAfterClaim: number): number | null; // 1->60_000, 2->300_000, >=3->null
export async function enqueueJob(repo: JobsRepo, type: JobType, siteId: string | null, payload?: Record<string, unknown>, opts?: { dedupe?: boolean }): Promise<{ id: string } | null>; // null if deduped
export async function processJobs(repo: JobsRepo, handlers: JobHandlers, opts?: { max?: number }): Promise<{ claimed: number; done: number; failed: number; retried: number }>;
```

- [ ] **Step 1: Write the failing tests**

`tests/jobs-service.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  computeRetryDelayMs, enqueueJob, processJobs,
} from "@/services/jobs/service";
import type { JobsRepo } from "@/services/jobs/repo";
import type { JobRow, JobType } from "@/services/jobs/types";

function memoryJobsRepo() {
  const rows: JobRow[] = [];
  let seq = 0;
  const repo: JobsRepo = {
    async insert(job) {
      const id = `job-${++seq}`;
      rows.push({
        id, type: job.type, site_id: job.site_id ?? null, batch_id: null,
        payload: job.payload ?? {}, status: "pending", attempts: 0,
        scheduled_for: job.scheduled_for ?? new Date(0).toISOString(), last_error: null,
      });
      return { id };
    },
    async pendingExists(type: JobType, siteId: string | null) {
      return rows.some((r) => r.type === type && r.site_id === siteId && r.status === "pending");
    },
    async claim(n) {
      const due = rows.filter((r) => r.status === "pending").slice(0, n);
      due.forEach((r) => { r.status = "running"; r.attempts += 1; });
      return due.map((r) => ({ ...r }));
    },
    async markDone(id) { rows.find((r) => r.id === id)!.status = "done"; },
    async retry(id, error, retryAtIso) {
      const r = rows.find((x) => x.id === id)!;
      r.status = "pending"; r.last_error = error; r.scheduled_for = retryAtIso;
    },
    async markFailed(id, error) {
      const r = rows.find((x) => x.id === id)!;
      r.status = "failed"; r.last_error = error;
    },
  };
  return { repo, rows };
}

describe("computeRetryDelayMs", () => {
  it("backs off 60s then 300s then gives up", () => {
    expect(computeRetryDelayMs(1)).toBe(60_000);
    expect(computeRetryDelayMs(2)).toBe(300_000);
    expect(computeRetryDelayMs(3)).toBeNull();
    expect(computeRetryDelayMs(4)).toBeNull();
  });
});

describe("enqueueJob", () => {
  it("inserts a pending job", async () => {
    const { repo, rows } = memoryJobsRepo();
    const res = await enqueueJob(repo, "snapshot_refresh", "site-1");
    expect(res?.id).toBe("job-1");
    expect(rows[0]).toMatchObject({ type: "snapshot_refresh", site_id: "site-1", status: "pending" });
  });

  it("dedupes when a pending job of same type+site exists", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    const dup = await enqueueJob(repo, "snapshot_refresh", "site-1", {}, { dedupe: true });
    expect(dup).toBeNull();
    expect(rows).toHaveLength(1);
  });
});

describe("processJobs", () => {
  it("runs handler and marks done", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    const seen: string[] = [];
    const res = await processJobs(repo, {
      snapshot_refresh: async ({ job }) => { seen.push(job.site_id!); },
    });
    expect(seen).toEqual(["site-1"]);
    expect(res).toMatchObject({ claimed: 1, done: 1, failed: 0, retried: 0 });
    expect(rows[0].status).toBe("done");
  });

  it("retries on failure with backoff, fails permanently after 3 attempts", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    const boom = { snapshot_refresh: async () => { throw new Error("nope"); } };

    let res = await processJobs(repo, boom);
    expect(res.retried).toBe(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].last_error).toBe("nope");

    res = await processJobs(repo, boom);
    expect(res.retried).toBe(1);

    res = await processJobs(repo, boom);
    expect(res.failed).toBe(1);
    expect(rows[0].status).toBe("failed");
  });

  it("fails a job with no registered handler permanently", async () => {
    const { repo, rows } = memoryJobsRepo();
    await enqueueJob(repo, "snapshot_refresh", "site-1");
    const res = await processJobs(repo, {});
    expect(res.failed).toBe(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toMatch(/no handler/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/jobs-service.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/services/jobs/types.ts`:
```ts
export type JobType = "snapshot_refresh";
export type JobStatus = "pending" | "running" | "awaiting_callback" | "done" | "failed";

export interface JobRow {
  id: string;
  type: JobType;
  site_id: string | null;
  batch_id: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  scheduled_for: string;
  last_error: string | null;
}
```

`src/services/jobs/repo.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow, JobType } from "./types";

export interface JobsRepo {
  insert(job: {
    type: JobType; site_id?: string | null;
    payload?: Record<string, unknown>; scheduled_for?: string;
  }): Promise<{ id: string }>;
  pendingExists(type: JobType, siteId: string | null): Promise<boolean>;
  claim(batchSize: number): Promise<JobRow[]>;
  markDone(id: string): Promise<void>;
  retry(id: string, error: string, retryAtIso: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

export function supabaseJobsRepo(db: SupabaseClient): JobsRepo {
  return {
    async insert(job) {
      const { data, error } = await db.from("jobs").insert({
        type: job.type,
        site_id: job.site_id ?? null,
        payload: job.payload ?? {},
        ...(job.scheduled_for ? { scheduled_for: job.scheduled_for } : {}),
      }).select("id").single();
      if (error) throw new Error(`jobs.insert failed: ${error.message}`, { cause: error });
      return { id: data.id };
    },
    async pendingExists(type, siteId) {
      let q = db.from("jobs").select("id", { head: true, count: "exact" })
        .eq("type", type).eq("status", "pending");
      q = siteId === null ? q.is("site_id", null) : q.eq("site_id", siteId);
      const { count, error } = await q;
      if (error) throw new Error(`jobs.pendingExists failed: ${error.message}`, { cause: error });
      return (count ?? 0) > 0;
    },
    async claim(batchSize) {
      const { data, error } = await db.rpc("claim_jobs", { batch_size: batchSize });
      if (error) throw new Error(`claim_jobs failed: ${error.message}`, { cause: error });
      return (data ?? []) as JobRow[];
    },
    async markDone(id) {
      const { error } = await db.from("jobs")
        .update({ status: "done", finished_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(`jobs.markDone failed: ${error.message}`, { cause: error });
    },
    async retry(id, err, retryAtIso) {
      const { error } = await db.from("jobs")
        .update({ status: "pending", last_error: err, scheduled_for: retryAtIso }).eq("id", id);
      if (error) throw new Error(`jobs.retry failed: ${error.message}`, { cause: error });
    },
    async markFailed(id, err) {
      const { error } = await db.from("jobs")
        .update({ status: "failed", last_error: err, finished_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error(`jobs.markFailed failed: ${error.message}`, { cause: error });
    },
  };
}
```

`src/services/jobs/service.ts`:
```ts
import type { JobsRepo } from "./repo";
import type { JobRow, JobType } from "./types";

export interface JobContext { job: JobRow }
export type JobHandler = (ctx: JobContext) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export function computeRetryDelayMs(attemptsAfterClaim: number): number | null {
  if (attemptsAfterClaim <= 1) return 60_000;
  if (attemptsAfterClaim === 2) return 300_000;
  return null;
}

export async function enqueueJob(
  repo: JobsRepo, type: JobType, siteId: string | null,
  payload: Record<string, unknown> = {}, opts: { dedupe?: boolean } = {},
): Promise<{ id: string } | null> {
  if (opts.dedupe && (await repo.pendingExists(type, siteId))) return null;
  return repo.insert({ type, site_id: siteId, payload });
}

export async function processJobs(
  repo: JobsRepo, handlers: JobHandlers, opts: { max?: number } = {},
): Promise<{ claimed: number; done: number; failed: number; retried: number }> {
  const jobs = await repo.claim(opts.max ?? 3);
  const result = { claimed: jobs.length, done: 0, failed: 0, retried: 0 };
  for (const job of jobs) {
    const handler = handlers[job.type];
    if (!handler) {
      await repo.markFailed(job.id, `no handler registered for job type "${job.type}"`);
      result.failed++;
      continue;
    }
    try {
      await handler({ job });
      await repo.markDone(job.id);
      result.done++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const delay = computeRetryDelayMs(job.attempts);
      if (delay === null) {
        await repo.markFailed(job.id, msg);
        result.failed++;
      } else {
        await repo.retry(job.id, msg, new Date(Date.now() + delay).toISOString());
        result.retried++;
      }
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → full suite green (16 existing + 7 new).

- [ ] **Step 5: Commit**

```powershell
git add src/services/jobs tests/jobs-service.test.ts; git commit -m "feat: jobs queue service with claim, backoff, and dispatch"
```

---

### Task 3: WP-CLI helper + MCP per-call timeout + command-aware mock (TDD)

**Files:**
- Create: `src/lib/wpcli.ts`
- Modify: `src/lib/mcp/client.ts` (executeAbility signature), `src/lib/mcp/mock.ts` (handler config)
- Test: `tests/wpcli.test.ts`

**Interfaces:**
- Consumes: `SiteMcpClient`, `McpToolError` from Phase 1.
- Produces:

```ts
// client.ts — CHANGED (backward compatible; update interface + impl + mock):
executeAbility(name: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;

// mock.ts — MockMcpClient config gains:
//   handler?: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>
// When handler is set it takes precedence over `results`. `calls` records as before.

// wpcli.ts
export function parseWpCliResult(result: unknown): string;      // extract stdout text; throw McpToolError on nonzero exit
export function parseJsonArray<T>(text: string): T[];            // tolerant: substring from first '[' to last ']'; [] for "Success:*" no-JSON output; throws on garbage
export async function runWpCli(client: SiteMcpClient, command: string, timeoutMs?: number): Promise<string>; // executes novamira/run-wp-cli
```

- [ ] **Step 1: Write the failing tests**

`tests/wpcli.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseWpCliResult, parseJsonArray, runWpCli } from "@/lib/wpcli";
import { MockMcpClient } from "@/lib/mcp/mock";
import { McpToolError } from "@/lib/mcp/errors";

describe("parseWpCliResult", () => {
  it("passes through plain strings", () => {
    expect(parseWpCliResult("6.7.1\n")).toBe("6.7.1");
  });
  it("extracts stdout from object results", () => {
    expect(parseWpCliResult({ stdout: "ok\n", stderr: "", exit_code: 0 })).toBe("ok");
    expect(parseWpCliResult({ output: "ok" })).toBe("ok");
  });
  it("throws McpToolError on nonzero exit code with stderr detail", () => {
    expect(() => parseWpCliResult({ stdout: "", stderr: "Error: boom", exit_code: 1 }))
      .toThrow(McpToolError);
  });
});

describe("parseJsonArray", () => {
  it("parses a clean JSON array", () => {
    expect(parseJsonArray<{ a: number }>('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it("strips CLI noise around the array", () => {
    expect(parseJsonArray('Warning: foo\n[{"name":"x"}]\n')).toEqual([{ name: "x" }]);
  });
  it("returns [] for Success-style non-JSON output", () => {
    expect(parseJsonArray("Success: WordPress is at the latest version.")).toEqual([]);
  });
  it("throws on garbage", () => {
    expect(() => parseJsonArray("<html>fatal error</html>")).toThrow();
  });
});

describe("runWpCli", () => {
  it("invokes novamira/run-wp-cli with the command and returns parsed stdout", async () => {
    const mock = new MockMcpClient({
      handler: (name, args) => {
        expect(name).toBe("novamira/run-wp-cli");
        return { stdout: `ran:${(args as { command: string }).command}`, exit_code: 0 };
      },
    });
    expect(await runWpCli(mock, "core version")).toBe("ran:core version");
    expect(mock.calls[0]).toMatchObject({ name: "novamira/run-wp-cli", args: { command: "core version" } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/wpcli.test.ts` → FAIL (module not found / handler unsupported).

- [ ] **Step 3: Implement**

In `src/lib/mcp/client.ts`, change the interface method and implementation:
```ts
// interface:
executeAbility(name: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;

// implementation inside createSiteMcpClient (replace the existing executeAbility):
async executeAbility(name, args = {}, callOpts = {}) {
  const callTimeout = callOpts.timeoutMs ?? timeout;
  try {
    const res = await client.callTool(
      { name: "mcp-adapter-execute-ability", arguments: { ability_name: name, parameters: args } },
      undefined, { timeout: callTimeout },
    );
    return parseToolResult(res);
  } catch (e) { throw mapConnectError(e); }
},
```

In `src/lib/mcp/mock.ts`, extend the config and `executeAbility`:
```ts
constructor(
  private config: {
    abilities?: DiscoveredAbility[];
    failWith?: Error;
    results?: Record<string, unknown>;
    handler?: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
  } = {},
) {}

async executeAbility(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  this.failIfConfigured();
  this.calls.push({ name, args });
  if (this.config.handler) return this.config.handler(name, args);
  return this.config.results?.[name] ?? null;
}
```

`src/lib/wpcli.ts`:
```ts
import type { SiteMcpClient } from "@/lib/mcp/client";
import { McpToolError } from "@/lib/mcp/errors";

export function parseWpCliResult(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const exit = typeof r.exit_code === "number" ? r.exit_code
      : typeof r.code === "number" ? r.code : 0;
    const stdout = typeof r.stdout === "string" ? r.stdout
      : typeof r.output === "string" ? r.output : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    if (exit !== 0) {
      throw new McpToolError(`WP-CLI exited with code ${exit}: ${stderr || stdout || "no output"}`);
    }
    return stdout.trim();
  }
  return String(result ?? "").trim();
}

export function parseJsonArray<T>(text: string): T[] {
  const trimmed = text.trim();
  if (/^success:/i.test(trimmed)) return [];
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Expected a JSON array in WP-CLI output, got: ${trimmed.slice(0, 120)}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as T[];
}

export async function runWpCli(
  client: SiteMcpClient, command: string, timeoutMs = 60_000,
): Promise<string> {
  const result = await client.executeAbility("novamira/run-wp-cli", { command }, { timeoutMs });
  return parseWpCliResult(result);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → full suite green. Also `npx tsc --noEmit` → 0 errors (the interface change is backward compatible; verify no existing caller broke).

- [ ] **Step 5: Commit**

```powershell
git add src/lib/wpcli.ts src/lib/mcp tests/wpcli.test.ts; git commit -m "feat: WP-CLI helper with tolerant parsing and per-call MCP timeouts"
```

---

### Task 4: Inventory service (TDD)

**Files:**
- Create: `src/services/inventory/types.ts`, `src/services/inventory/repo.ts`, `src/services/inventory/service.ts`
- Test: `tests/inventory.test.ts`

**Interfaces:**
- Consumes: `runWpCli`, `parseJsonArray` (Task 3); `SiteMcpClient`, `McpFactory`; `decryptSecret`; `SitesRepo.getSiteCredentials` (Phase 1).
- Produces:

```ts
// types.ts
export interface PluginInfo { name: string; title?: string; version: string; status: string; update: string; update_version?: string | null }
export interface ThemeInfo  { name: string; title?: string; version: string; status: string; update: string; update_version?: string | null }
export interface AdminUser  { ID: number; user_login: string; user_email: string }
export interface InventoryPayload {
  collected_at: string; wp_version: string; php_version: string;
  core_update: string | null;               // available version or null
  plugins: PluginInfo[]; themes: ThemeInfo[]; admin_users: AdminUser[];
}
export function pendingUpdates(p: InventoryPayload): number; // plugins w/ update==="available" + themes same + core (1|0)

// repo.ts
export interface SnapshotsRepo {
  insertSnapshot(siteId: string, payload: InventoryPayload): Promise<void>;
  latestSnapshot(siteId: string): Promise<{ payload: InventoryPayload; taken_at: string } | null>;
}
export function supabaseSnapshotsRepo(db: SupabaseClient): SnapshotsRepo;

// service.ts
export async function collectInventory(client: SiteMcpClient): Promise<InventoryPayload>;
export interface InventoryDeps { sites: SitesRepo; snapshots: SnapshotsRepo; mcp: McpFactory }
export async function refreshSnapshot(deps: InventoryDeps, siteId: string): Promise<InventoryPayload>; // opens MCP, collects, stores, closes
```

- [ ] **Step 1: Write the failing tests**

`tests/inventory.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { collectInventory } from "@/services/inventory/service";
import { pendingUpdates, type InventoryPayload } from "@/services/inventory/types";
import { MockMcpClient } from "@/lib/mcp/mock";

const CLI_FIXTURES: Record<string, unknown> = {
  "core version": "6.7.1",
  "eval 'echo PHP_VERSION;'": "8.2.20",
  "plugin list --format=json --fields=name,title,version,status,update,update_version":
    '[{"name":"akismet","title":"Akismet","version":"5.3","status":"active","update":"available","update_version":"5.4"},' +
    '{"name":"hello","title":"Hello Dolly","version":"1.7","status":"inactive","update":"none","update_version":null}]',
  "theme list --format=json --fields=name,title,version,status,update,update_version":
    '[{"name":"generatepress","title":"GeneratePress","version":"3.4","status":"active","update":"none","update_version":null}]',
  "core check-update --format=json":
    '[{"version":"6.8","update_type":"major"}]',
  "user list --role=administrator --format=json --fields=ID,user_login,user_email":
    '[{"ID":1,"user_login":"admin","user_email":"a@b.co"}]',
};

function fixtureClient(overrides: Record<string, unknown> = {}) {
  const table = { ...CLI_FIXTURES, ...overrides };
  return new MockMcpClient({
    handler: (name, args) => {
      if (name !== "novamira/run-wp-cli") throw new Error(`unexpected ability ${name}`);
      const cmd = (args as { command: string }).command;
      if (!(cmd in table)) throw new Error(`no fixture for command: ${cmd}`);
      return { stdout: String(table[cmd]), exit_code: 0 };
    },
  });
}

describe("collectInventory", () => {
  it("collects versions, plugins, themes, core update, and admins", async () => {
    const inv = await collectInventory(fixtureClient());
    expect(inv.wp_version).toBe("6.7.1");
    expect(inv.php_version).toBe("8.2.20");
    expect(inv.core_update).toBe("6.8");
    expect(inv.plugins).toHaveLength(2);
    expect(inv.plugins[0]).toMatchObject({ name: "akismet", update: "available" });
    expect(inv.themes[0].name).toBe("generatepress");
    expect(inv.admin_users[0].user_login).toBe("admin");
    expect(inv.collected_at).toMatch(/^\d{4}-/);
  });

  it("treats 'Success: latest version' as no core update", async () => {
    const inv = await collectInventory(fixtureClient({
      "core check-update --format=json": "Success: WordPress is at the latest version.",
    }));
    expect(inv.core_update).toBeNull();
  });
});

describe("pendingUpdates", () => {
  it("counts plugin + theme + core updates", async () => {
    const inv = await collectInventory(fixtureClient());
    // 1 plugin update + 0 theme updates + 1 core update
    expect(pendingUpdates(inv)).toBe(2);
  });
  it("is zero when everything is current", async () => {
    const inv = await collectInventory(fixtureClient({
      "plugin list --format=json --fields=name,title,version,status,update,update_version": "[]",
      "theme list --format=json --fields=name,title,version,status,update,update_version": "[]",
      "core check-update --format=json": "Success: WordPress is at the latest version.",
    }));
    expect(pendingUpdates(inv)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/inventory.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/services/inventory/types.ts`:
```ts
export interface PluginInfo {
  name: string; title?: string; version: string; status: string;
  update: string; update_version?: string | null;
}
export interface ThemeInfo {
  name: string; title?: string; version: string; status: string;
  update: string; update_version?: string | null;
}
export interface AdminUser { ID: number; user_login: string; user_email: string }

export interface InventoryPayload {
  collected_at: string;
  wp_version: string;
  php_version: string;
  core_update: string | null;
  plugins: PluginInfo[];
  themes: ThemeInfo[];
  admin_users: AdminUser[];
}

export function pendingUpdates(p: InventoryPayload): number {
  const plugins = p.plugins.filter((x) => x.update === "available").length;
  const themes = p.themes.filter((x) => x.update === "available").length;
  return plugins + themes + (p.core_update ? 1 : 0);
}
```

`src/services/inventory/repo.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InventoryPayload } from "./types";

export interface SnapshotsRepo {
  insertSnapshot(siteId: string, payload: InventoryPayload): Promise<void>;
  latestSnapshot(siteId: string): Promise<{ payload: InventoryPayload; taken_at: string } | null>;
}

export function supabaseSnapshotsRepo(db: SupabaseClient): SnapshotsRepo {
  return {
    async insertSnapshot(siteId, payload) {
      const { error } = await db.from("site_snapshots").insert({ site_id: siteId, payload });
      if (error) throw new Error(`insertSnapshot failed: ${error.message}`, { cause: error });
    },
    async latestSnapshot(siteId) {
      const { data, error } = await db.from("site_snapshots")
        .select("payload,taken_at").eq("site_id", siteId)
        .order("taken_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`latestSnapshot failed: ${error.message}`, { cause: error });
      return data ? { payload: data.payload as InventoryPayload, taken_at: data.taken_at } : null;
    },
  };
}
```

`src/services/inventory/service.ts`:
```ts
import { runWpCli, parseJsonArray } from "@/lib/wpcli";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { McpFactory, SiteMcpClient } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { SnapshotsRepo } from "./repo";
import type { AdminUser, InventoryPayload, PluginInfo, ThemeInfo } from "./types";

const FIELDS = "name,title,version,status,update,update_version";

export async function collectInventory(client: SiteMcpClient): Promise<InventoryPayload> {
  const wp_version = await runWpCli(client, "core version");
  const php_version = await runWpCli(client, "eval 'echo PHP_VERSION;'");
  const plugins = parseJsonArray<PluginInfo>(
    await runWpCli(client, `plugin list --format=json --fields=${FIELDS}`),
  );
  const themes = parseJsonArray<ThemeInfo>(
    await runWpCli(client, `theme list --format=json --fields=${FIELDS}`),
  );
  let core_update: string | null = null;
  try {
    const updates = parseJsonArray<{ version: string }>(
      await runWpCli(client, "core check-update --format=json"),
    );
    core_update = updates[0]?.version ?? null;
  } catch {
    core_update = null; // check-update output is advisory; never fail a snapshot on it
  }
  const admin_users = parseJsonArray<AdminUser>(
    await runWpCli(client, "user list --role=administrator --format=json --fields=ID,user_login,user_email"),
  );
  return {
    collected_at: new Date().toISOString(),
    wp_version, php_version, core_update, plugins, themes, admin_users,
  };
}

export interface InventoryDeps { sites: SitesRepo; snapshots: SnapshotsRepo; mcp: McpFactory }

export async function refreshSnapshot(deps: InventoryDeps, siteId: string): Promise<InventoryPayload> {
  const creds = await deps.sites.getSiteCredentials(siteId);
  if (!creds) throw new Error(`Site not found: ${siteId}`);
  const client = await deps.mcp({
    endpoint: creds.mcp_endpoint,
    username: creds.wp_username,
    appPassword: await decryptSecret(creds.app_password_encrypted),
  });
  try {
    const payload = await collectInventory(client);
    await deps.snapshots.insertSnapshot(siteId, payload);
    return payload;
  } finally {
    await client.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → full suite green.

- [ ] **Step 5: Commit**

```powershell
git add src/services/inventory tests/inventory.test.ts; git commit -m "feat: inventory collection over WP-CLI and snapshot storage"
```

---

### Task 5: Cron routes + vercel.json + scheduling docs

**Files:**
- Create: `src/lib/cron-auth.ts`, `src/app/api/cron/process/route.ts`, `src/app/api/cron/enqueue/route.ts`, `vercel.json`, `docs/ops/scheduling.md`

**Interfaces:**
- Consumes: `processJobs`, `enqueueJob`, `supabaseJobsRepo` (Task 2); `refreshSnapshot`, `supabaseSnapshotsRepo` (Task 4); `supabaseSitesRepo`, `createServiceSupabase`, `createSiteMcpClient`, `getEnv`.
- Produces: `POST|GET /api/cron/process` and `POST|GET /api/cron/enqueue` (JSON `{ok, ...counts}`); `isAuthorizedCronRequest(req: Request): boolean`.

- [ ] **Step 1: Implement cron auth**

`src/lib/cron-auth.ts`:
```ts
import { getEnv } from "@/lib/env";

export function isAuthorizedCronRequest(req: Request): boolean {
  const secret = getEnv("CRON_SECRET");
  const header = req.headers.get("x-cron-secret");
  const auth = req.headers.get("authorization");
  return header === secret || auth === `Bearer ${secret}`;
}
```

- [ ] **Step 2: Implement the process route**

`src/app/api/cron/process/route.ts`:
```ts
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { processJobs, type JobHandlers } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { refreshSnapshot } from "@/services/inventory/service";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceSupabase();
  const handlers: JobHandlers = {
    snapshot_refresh: async ({ job }) => {
      if (!job.site_id) throw new Error("snapshot_refresh requires site_id");
      await refreshSnapshot(
        { sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db), mcp: createSiteMcpClient },
        job.site_id,
      );
    },
  };
  const result = await processJobs(supabaseJobsRepo(db), handlers, { max: 3 });
  return NextResponse.json({ ok: true, ...result });
}

export const POST = run;
export const GET = run;
```

- [ ] **Step 3: Implement the enqueue route**

`src/app/api/cron/enqueue/route.ts`:
```ts
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { enqueueJob } from "@/services/jobs/service";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceSupabase();
  const sites = await supabaseSitesRepo(db).listSites();
  const jobs = supabaseJobsRepo(db);
  let enqueued = 0;
  for (const site of sites) {
    if (site.status === "disabled") continue;
    const res = await enqueueJob(jobs, "snapshot_refresh", site.id, {}, { dedupe: true });
    if (res) enqueued++;
  }
  return NextResponse.json({ ok: true, sites: sites.length, enqueued });
}

export const POST = run;
export const GET = run;
```

- [ ] **Step 4: vercel.json backstop + scheduling docs**

`vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/enqueue", "schedule": "0 3 * * *" }
  ]
}
```
(Vercel cron sends GET with `Authorization: Bearer $CRON_SECRET` when the `CRON_SECRET` env var is set in the project — the auth helper accepts that form. pg_cron carries per-minute processing; this daily entry is only a backstop.)

> **Superseded (2026-08-29):** this backstop cron double-ran the nightly
> fan-out in production — `vercel.json` must declare no `crons` entry; see
> `docs/ops/scheduling.md`. Left here only as history of what not to rebuild.

`docs/ops/scheduling.md`:
```markdown
# Scheduling (pg_cron + pg_net)

Vercel Hobby crons run at most once per day, so fine-grained schedules live in
Supabase. Run this ONCE in the Supabase SQL editor after deploying the app.
Replace `APP_URL` (your deployed origin, e.g. https://wp-panel.vercel.app) and
`CRON_SECRET` (same value as the Vercel env var).

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- process due jobs every minute
select cron.schedule('wp-panel-process', '* * * * *', $$
  select net.http_post(
    url := 'APP_URL/api/cron/process',
    headers := jsonb_build_object('x-cron-secret', 'CRON_SECRET')
  );
$$);

-- nightly snapshot fan-out at 02:00 UTC
select cron.schedule('wp-panel-enqueue', '0 2 * * *', $$
  select net.http_post(
    url := 'APP_URL/api/cron/enqueue',
    headers := jsonb_build_object('x-cron-secret', 'CRON_SECRET')
  );
$$);
```

Inspect: `select * from cron.job;` — Unschedule: `select cron.unschedule('wp-panel-process');`

Local dev has no scheduler: hit the routes manually, e.g.
`curl -H "x-cron-secret: <secret>" http://localhost:3000/api/cron/enqueue`
then `.../api/cron/process`.
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` → 0 errors; `npm test` → green; `npm run build` → success (routes compile; they read env at request time only).

```powershell
git add src/lib/cron-auth.ts src/app/api vercel.json docs/ops; git commit -m "feat: cron process/enqueue routes with pg_cron wiring docs"
```

---

### Task 6: Management actions service (TDD)

**Files:**
- Create: `src/services/manage/types.ts`, `src/services/manage/service.ts`
- Test: `tests/manage.test.ts`

**Interfaces:**
- Consumes: `runWpCli` (Task 3), `decryptSecret`, `McpFactory`, `SitesRepo` (getSiteCredentials + insertActivity), `JobsRepo` + `enqueueJob` (Task 2).
- Produces:

```ts
// types.ts
export type ManageAction =
  | { kind: "update_core" }
  | { kind: "update_plugin"; slug: string }
  | { kind: "update_all_plugins" }
  | { kind: "update_theme"; slug: string }
  | { kind: "activate_plugin"; slug: string }
  | { kind: "deactivate_plugin"; slug: string }
  | { kind: "maintenance"; enable: boolean }
  | { kind: "flush_cache" }
  | { kind: "flush_permalinks" };

// service.ts
export const SLUG_RE: RegExp;                                   // /^[a-z0-9._-]+$/i
export function buildCommands(action: ManageAction): string[];  // throws Error("Invalid slug") on bad slug
export interface ManageDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }
export async function manageSite(deps: ManageDeps, siteId: string, actorId: string, action: ManageAction):
  Promise<{ ok: boolean; output?: string; error?: string }>;
// runs commands sequentially (180s timeout each), logs activity `site.manage.<kind>`,
// enqueues deduped snapshot_refresh on success
```

- [ ] **Step 1: Write the failing tests**

`tests/manage.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { buildCommands, manageSite } from "@/services/manage/service";
import type { ManageDeps } from "@/services/manage/service";
import { MockMcpClient } from "@/lib/mcp/mock";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("buildCommands", () => {
  it("maps every action kind to WP-CLI commands", () => {
    expect(buildCommands({ kind: "update_core" })).toEqual(["core update", "core update-db"]);
    expect(buildCommands({ kind: "update_plugin", slug: "akismet" })).toEqual(["plugin update akismet"]);
    expect(buildCommands({ kind: "update_all_plugins" })).toEqual(["plugin update --all"]);
    expect(buildCommands({ kind: "update_theme", slug: "generatepress" })).toEqual(["theme update generatepress"]);
    expect(buildCommands({ kind: "activate_plugin", slug: "akismet" })).toEqual(["plugin activate akismet"]);
    expect(buildCommands({ kind: "deactivate_plugin", slug: "akismet" })).toEqual(["plugin deactivate akismet"]);
    expect(buildCommands({ kind: "maintenance", enable: true })).toEqual(["maintenance-mode activate"]);
    expect(buildCommands({ kind: "maintenance", enable: false })).toEqual(["maintenance-mode deactivate"]);
    expect(buildCommands({ kind: "flush_cache" })).toEqual(["cache flush"]);
    expect(buildCommands({ kind: "flush_permalinks" })).toEqual(["rewrite flush --hard"]);
  });

  it("rejects slug injection attempts", () => {
    for (const bad of ["a; rm -rf /", "a && b", "a b", "a`b`", "a$(x)", "", "a|b"]) {
      expect(() => buildCommands({ kind: "update_plugin", slug: bad })).toThrow(/invalid slug/i);
    }
  });
});

function fakeDeps(mock: MockMcpClient) {
  const activity: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let credsEncrypted = "";
  const sites = {
    async getSiteCredentials(id: string) {
      return id === "site-1"
        ? { mcp_endpoint: "https://x/wp-json/mcp/novamira", wp_username: "admin", app_password_encrypted: credsEncrypted }
        : null;
    },
    async insertActivity(e: Record<string, unknown>) { activity.push(e); },
  } as unknown as SitesRepo;
  const jobs = {
    async pendingExists() { return false; },
    async insert(j: Record<string, unknown>) { enqueued.push(j); return { id: "job-1" }; },
  } as unknown as JobsRepo;
  const deps: ManageDeps = { sites, jobs, mcp: async () => mock };
  return { deps, activity, enqueued, setCreds: (v: string) => { credsEncrypted = v; } };
}

describe("manageSite", () => {
  it("runs the command, logs activity, enqueues snapshot refresh", async () => {
    const mock = new MockMcpClient({ handler: () => ({ stdout: "Success: Updated 1 of 1 plugins.", exit_code: 0 }) });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await manageSite(f.deps, "site-1", "user-1", { kind: "update_plugin", slug: "akismet" });
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/Success/);
    expect(mock.calls[0].args).toMatchObject({ command: "plugin update akismet" });
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ actor: "user-1", site_id: "site-1", action: "site.manage.update_plugin" });
    expect(f.enqueued[0]).toMatchObject({ type: "snapshot_refresh", site_id: "site-1" });
  });

  it("returns ok:false with the error, logs the failure, does not enqueue refresh", async () => {
    const mock = new MockMcpClient({ handler: () => ({ stdout: "", stderr: "Error: plugin not found", exit_code: 1 }) });
    const f = fakeDeps(mock);
    f.setCreds(await encryptSecret("pass"));
    const res = await manageSite(f.deps, "site-1", "user-1", { kind: "update_plugin", slug: "ghost" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/plugin not found/);
    expect(mock.closed).toBe(true);
    expect(f.activity[0]).toMatchObject({ action: "site.manage.update_plugin" });
    expect(f.enqueued).toHaveLength(0);
  });

  it("fails cleanly for an unknown site", async () => {
    const f = fakeDeps(new MockMcpClient());
    const res = await manageSite(f.deps, "nope", "user-1", { kind: "flush_cache" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/manage.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/services/manage/types.ts`:
```ts
export type ManageAction =
  | { kind: "update_core" }
  | { kind: "update_plugin"; slug: string }
  | { kind: "update_all_plugins" }
  | { kind: "update_theme"; slug: string }
  | { kind: "activate_plugin"; slug: string }
  | { kind: "deactivate_plugin"; slug: string }
  | { kind: "maintenance"; enable: boolean }
  | { kind: "flush_cache" }
  | { kind: "flush_permalinks" };
```

`src/services/manage/service.ts`:
```ts
import { runWpCli } from "@/lib/wpcli";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "@/services/sites/repo";
import type { JobsRepo } from "@/services/jobs/repo";
import { enqueueJob } from "@/services/jobs/service";
import type { ManageAction } from "./types";

export const SLUG_RE = /^[a-z0-9._-]+$/i;
const ACTION_TIMEOUT_MS = 180_000;

function slug(s: string): string {
  if (!SLUG_RE.test(s)) throw new Error(`Invalid slug: ${JSON.stringify(s)}`);
  return s;
}

export function buildCommands(action: ManageAction): string[] {
  switch (action.kind) {
    case "update_core": return ["core update", "core update-db"];
    case "update_plugin": return [`plugin update ${slug(action.slug)}`];
    case "update_all_plugins": return ["plugin update --all"];
    case "update_theme": return [`theme update ${slug(action.slug)}`];
    case "activate_plugin": return [`plugin activate ${slug(action.slug)}`];
    case "deactivate_plugin": return [`plugin deactivate ${slug(action.slug)}`];
    case "maintenance": return [action.enable ? "maintenance-mode activate" : "maintenance-mode deactivate"];
    case "flush_cache": return ["cache flush"];
    case "flush_permalinks": return ["rewrite flush --hard"];
  }
}

export interface ManageDeps { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }

export async function manageSite(
  deps: ManageDeps, siteId: string, actorId: string, action: ManageAction,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  let commands: string[];
  try {
    commands = buildCommands(action);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
      for (const cmd of commands) {
        output = await runWpCli(client, cmd, ACTION_TIMEOUT_MS);
      }
    } finally {
      await client.close();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: `site.manage.${action.kind}`,
    detail: { action, ok: !error, ...(error ? { error } : {}) },
  });
  if (!error) {
    await enqueueJob(deps.jobs, "snapshot_refresh", siteId, {}, { dedupe: true });
    return { ok: true, output };
  }
  return { ok: false, error };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → full suite green.

- [ ] **Step 5: Commit**

```powershell
git add src/services/manage tests/manage.test.ts; git commit -m "feat: site management actions with slug validation and activity logging"
```

---

### Task 7: SiteTabs + server actions + Plugins tab UI

**Files:**
- Create: `src/app/(dashboard)/sites/[id]/tabs.tsx`, `src/app/(dashboard)/sites/[id]/confirm-button.tsx`, `src/app/(dashboard)/sites/[id]/manage-actions.ts`, `src/app/(dashboard)/sites/[id]/plugins/page.tsx`
- Modify: `src/app/(dashboard)/sites/[id]/page.tsx` (replace inline TABS nav with `<SiteTabs>`)

**Interfaces:**
- Consumes: `manageSite`, `ManageAction` (Task 6); `refreshSnapshot`, `supabaseSnapshotsRepo`, `pendingUpdates` (Task 4); `supabaseJobsRepo` (Task 2); Phase 1 site service/repo/auth.
- Produces:
  - `SiteTabs({ siteId, active }: { siteId: string; active: "overview" | "plugins" | "themes" })` — links for Overview/Plugins/Themes; Security/SEO/GeoGrid/Reports stay disabled spans with `aria-disabled` + sr-only "(coming in a later phase)".
  - `ConfirmButton({ label, pendingLabel?, confirmMessage, className? })` — client submit button that calls `window.confirm` and respects `useFormStatus` pending.
  - Server actions: `manageAction(siteId: string, action: ManageAction): Promise<{ ok: boolean; error?: string }>` and `refreshInventoryAction(siteId: string): Promise<{ ok: boolean; error?: string }>` (both revalidate the site's pages).
  - Route `/sites/[id]/plugins`.

- [ ] **Step 1: Implement SiteTabs**

`src/app/(dashboard)/sites/[id]/tabs.tsx`:
```tsx
import Link from "next/link";

const LIVE = [
  { key: "overview", label: "Overview", href: (id: string) => `/sites/${id}` },
  { key: "plugins", label: "Plugins", href: (id: string) => `/sites/${id}/plugins` },
  { key: "themes", label: "Themes", href: (id: string) => `/sites/${id}/themes` },
] as const;
const COMING = ["Security", "SEO", "GeoGrid", "Reports"];

export type SiteTabKey = (typeof LIVE)[number]["key"];

export function SiteTabs({ siteId, active }: { siteId: string; active: SiteTabKey }) {
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b">
      {LIVE.map((t) => (
        <Link key={t.key} href={t.href(siteId)}
          aria-current={active === t.key ? "page" : undefined}
          className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm ${active === t.key
            ? "border-b-2 border-slate-900 font-medium"
            : "text-slate-600 hover:text-slate-900"}`}>
          {t.label}
        </Link>
      ))}
      {COMING.map((t) => (
        <span key={t} aria-disabled="true" title="Coming in a later phase"
          className="shrink-0 cursor-not-allowed whitespace-nowrap px-3 py-2 text-sm text-slate-400">
          {t}<span className="sr-only"> (coming in a later phase)</span>
        </span>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Implement ConfirmButton**

`src/app/(dashboard)/sites/[id]/confirm-button.tsx`:
```tsx
"use client";

import { useFormStatus } from "react-dom";

export function ConfirmButton({
  label, pendingLabel, confirmMessage, className,
}: {
  label: string; pendingLabel?: string; confirmMessage: string; className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className={className ?? "rounded border px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"}
      onClick={(e) => {
        if (!window.confirm(confirmMessage)) e.preventDefault();
      }}>
      {pending ? (pendingLabel ?? "Working…") : label}
    </button>
  );
}
```

- [ ] **Step 3: Implement server actions**

`src/app/(dashboard)/sites/[id]/manage-actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { manageSite } from "@/services/manage/service";
import type { ManageAction } from "@/services/manage/types";
import { refreshSnapshot } from "@/services/inventory/service";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

function revalidateSite(siteId: string) {
  for (const p of [`/sites/${siteId}`, `/sites/${siteId}/plugins`, `/sites/${siteId}/themes`, "/dashboard"]) {
    revalidatePath(p);
  }
}

export async function manageAction(
  siteId: string, action: ManageAction,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const db = createServiceSupabase();
  const result = await manageSite(
    { sites: supabaseSitesRepo(db), jobs: supabaseJobsRepo(db), mcp: createSiteMcpClient },
    siteId, user.id, action,
  );
  revalidateSite(siteId);
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}

export async function refreshInventoryAction(
  siteId: string,
): Promise<{ ok: boolean; error?: string }> {
  await requireUser();
  const db = createServiceSupabase();
  try {
    await refreshSnapshot(
      { sites: supabaseSitesRepo(db), snapshots: supabaseSnapshotsRepo(db), mcp: createSiteMcpClient },
      siteId,
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Refresh failed" };
  }
  revalidateSite(siteId);
  return { ok: true };
}
```

- [ ] **Step 4: Implement the Plugins page**

`src/app/(dashboard)/sites/[id]/plugins/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { SiteTabs } from "../tabs";
import { ConfirmButton } from "../confirm-button";
import { manageAction, refreshInventoryAction } from "../manage-actions";

export const dynamic = "force-dynamic";

export default async function PluginsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const plugins = snapshot?.payload.plugins ?? [];
  const updatable = plugins.filter((p) => p.update === "available");

  const refresh = refreshInventoryAction.bind(null, id) as unknown as () => Promise<void>;
  const updateAll = manageAction.bind(null, id, { kind: "update_all_plugins" as const }) as unknown as () => Promise<void>;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Plugins</p>
      <SiteTabs siteId={id} active="plugins" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {snapshot
            ? `${plugins.length} plugins · ${updatable.length} updates · inventory from ${new Date(snapshot.taken_at).toLocaleString()}`
            : "No inventory yet — refresh to load plugins."}
        </p>
        <div className="flex gap-2">
          <form action={refresh}>
            <ConfirmButton label="Refresh inventory" pendingLabel="Refreshing…"
              confirmMessage="Fetch fresh inventory from the site now?" />
          </form>
          {updatable.length > 0 && (
            <form action={updateAll}>
              <ConfirmButton label={`Update all (${updatable.length})`} pendingLabel="Updating…"
                confirmMessage={`Update ${updatable.length} plugin(s) on ${site.name}?`}
                className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" />
            </form>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Plugin</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Update</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {plugins.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                {snapshot ? "No plugins found." : "Refresh inventory to see plugins."}
              </td></tr>
            ) : plugins.map((p) => {
              const activate = manageAction.bind(null, id, { kind: "activate_plugin" as const, slug: p.name }) as unknown as () => Promise<void>;
              const deactivate = manageAction.bind(null, id, { kind: "deactivate_plugin" as const, slug: p.name }) as unknown as () => Promise<void>;
              const update = manageAction.bind(null, id, { kind: "update_plugin" as const, slug: p.name }) as unknown as () => Promise<void>;
              return (
                <tr key={p.name} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{p.title || p.name}</td>
                  <td className="px-4 py-2">{p.version}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${p.status === "active"
                      ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {p.update === "available"
                      ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          {p.update_version ?? "available"}
                        </span>
                      : <span className="text-xs text-slate-400">current</span>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      {p.update === "available" && (
                        <form action={update}>
                          <ConfirmButton label="Update" pendingLabel="…"
                            confirmMessage={`Update ${p.name} to ${p.update_version ?? "latest"}?`} />
                        </form>
                      )}
                      {p.status === "active" ? (
                        <form action={deactivate}>
                          <ConfirmButton label="Deactivate" pendingLabel="…"
                            confirmMessage={`Deactivate ${p.name}? The site may lose functionality.`} />
                        </form>
                      ) : (
                        <form action={activate}>
                          <ConfirmButton label="Activate" pendingLabel="…"
                            confirmMessage={`Activate ${p.name}?`} />
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Swap the overview page's inline tab nav for SiteTabs**

In `src/app/(dashboard)/sites/[id]/page.tsx`: delete the `TABS` const and the whole `<nav className="mb-6 flex gap-1 overflow-x-auto border-b">…</nav>` block; add `import { SiteTabs } from "./tabs";` and render `<SiteTabs siteId={id} active="overview" />` in its place. Change the outer `<main>` class to `mx-auto max-w-5xl p-4 sm:p-6` for consistency.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit` → 0 errors; `npm test` → green; `npm run build` → success.

```powershell
git add "src/app/(dashboard)/sites/[id]"; git commit -m "feat: plugins tab with manage actions, confirm dialogs, and shared site tabs"
```

---

### Task 8: Themes tab + overview upgrades (core banner, tools card, admins)

**Files:**
- Create: `src/app/(dashboard)/sites/[id]/themes/page.tsx`
- Modify: `src/app/(dashboard)/sites/[id]/page.tsx`

**Interfaces:**
- Consumes: everything from Task 7 (`SiteTabs`, `ConfirmButton`, `manageAction`, `refreshInventoryAction`), `supabaseSnapshotsRepo`, `pendingUpdates`.
- Produces: route `/sites/[id]/themes`; upgraded overview.

- [ ] **Step 1: Implement the Themes page**

`src/app/(dashboard)/sites/[id]/themes/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { SiteTabs } from "../tabs";
import { ConfirmButton } from "../confirm-button";
import { manageAction, refreshInventoryAction } from "../manage-actions";

export const dynamic = "force-dynamic";

export default async function ThemesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();
  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const themes = snapshot?.payload.themes ?? [];

  const refresh = refreshInventoryAction.bind(null, id) as unknown as () => Promise<void>;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="mb-1 text-2xl font-semibold">{site.name}</h1>
      <p className="mb-4 text-sm text-slate-500">Themes</p>
      <SiteTabs siteId={id} active="themes" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {snapshot
            ? `${themes.length} themes · inventory from ${new Date(snapshot.taken_at).toLocaleString()}`
            : "No inventory yet — refresh to load themes."}
        </p>
        <form action={refresh}>
          <ConfirmButton label="Refresh inventory" pendingLabel="Refreshing…"
            confirmMessage="Fetch fresh inventory from the site now?" />
        </form>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Theme</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Update</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {themes.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                {snapshot ? "No themes found." : "Refresh inventory to see themes."}
              </td></tr>
            ) : themes.map((t) => {
              const update = manageAction.bind(null, id, { kind: "update_theme" as const, slug: t.name }) as unknown as () => Promise<void>;
              return (
                <tr key={t.name} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{t.title || t.name}</td>
                  <td className="px-4 py-2">{t.version}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${t.status === "active"
                      ? "bg-green-100 text-green-800" : "bg-slate-200 text-slate-600"}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {t.update === "available"
                      ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          {t.update_version ?? "available"}
                        </span>
                      : <span className="text-xs text-slate-400">current</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {t.update === "available" && (
                      <form action={update}>
                        <ConfirmButton label="Update" pendingLabel="…"
                          confirmMessage={`Update theme ${t.name} to ${t.update_version ?? "latest"}?`} />
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Upgrade the overview page**

In `src/app/(dashboard)/sites/[id]/page.tsx`, after the existing snapshot-free content, wire in the latest snapshot. The page becomes:

```tsx
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { runConnectionTest } from "./actions";
import { SiteTabs } from "./tabs";
import { ConfirmButton } from "./confirm-button";
import { manageAction, refreshInventoryAction } from "./manage-actions";

export const dynamic = "force-dynamic";

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceSupabase();
  const site = await getSite({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, id);
  if (!site) notFound();

  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(id);
  const inv = snapshot?.payload ?? null;

  const { data: activity } = await db
    .from("activity_log")
    .select("action,detail,at")
    .eq("site_id", id)
    .order("at", { ascending: false })
    .limit(10);

  const testAction = runConnectionTest.bind(null, id) as unknown as (formData: FormData) => Promise<void>;
  const refresh = refreshInventoryAction.bind(null, id) as unknown as () => Promise<void>;
  const updateCore = manageAction.bind(null, id, { kind: "update_core" as const }) as unknown as () => Promise<void>;
  const maintenanceOn = manageAction.bind(null, id, { kind: "maintenance" as const, enable: true }) as unknown as () => Promise<void>;
  const maintenanceOff = manageAction.bind(null, id, { kind: "maintenance" as const, enable: false }) as unknown as () => Promise<void>;
  const flushCache = manageAction.bind(null, id, { kind: "flush_cache" as const }) as unknown as () => Promise<void>;
  const flushPermalinks = manageAction.bind(null, id, { kind: "flush_permalinks" as const }) as unknown as () => Promise<void>;

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 break-words text-2xl font-semibold">{site.name}</h1>
        <div className="flex gap-2">
          <form action={refresh}>
            <ConfirmButton label="Refresh inventory" pendingLabel="Refreshing…"
              confirmMessage="Fetch fresh inventory from the site now?" />
          </form>
          <form action={testAction}>
            <button className="rounded border px-3 py-2 text-sm hover:bg-slate-100">
              Test connection
            </button>
          </form>
        </div>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        <a href={site.url} target="_blank" rel="noreferrer" className="break-all underline">{site.url}</a>
        {" · "}status: {site.status.replace("_", " ")}
        {inv ? ` · WP ${inv.wp_version} · PHP ${inv.php_version}` : ""}
      </p>

      <SiteTabs siteId={id} active="overview" />

      {inv?.core_update && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <span>WordPress {inv.core_update} is available (current: {inv.wp_version}).</span>
          <form action={updateCore}>
            <ConfirmButton label="Update core" pendingLabel="Updating…"
              confirmMessage={`Update WordPress core on ${site.name} to ${inv.core_update}? Back up first if unsure.`}
              className="rounded bg-amber-600 px-3 py-2 text-sm text-white disabled:opacity-50" />
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Connection</h2>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="shrink-0 text-slate-500">MCP endpoint</dt>
              <dd className="min-w-0 truncate pl-4" title={site.mcp_endpoint}>{site.mcp_endpoint}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">WP user</dt>
              <dd>{site.wp_username}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Abilities</dt>
              <dd>{site.capabilities?.abilities?.length ?? 0}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Connected</dt>
              <dd>{new Date(site.created_at).toLocaleDateString()}</dd></div>
            {snapshot && (
              <div className="flex justify-between"><dt className="text-slate-500">Inventory</dt>
                <dd>{new Date(snapshot.taken_at).toLocaleString()}</dd></div>
            )}
          </dl>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-slate-500">All abilities</summary>
            <ul className="mt-2 max-h-48 overflow-y-auto text-xs text-slate-600">
              {(site.capabilities?.abilities ?? []).map((a) => <li key={a}>{a}</li>)}
            </ul>
          </details>
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Recent activity</h2>
          {!activity?.length ? (
            <p className="text-sm text-slate-500">No activity yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {activity.map((a, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{a.action}</span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {new Date(a.at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Tools</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            <form action={maintenanceOn}>
              <ConfirmButton label="Maintenance on" pendingLabel="…"
                confirmMessage={`Put ${site.name} into maintenance mode? Visitors will see a maintenance page.`} />
            </form>
            <form action={maintenanceOff}>
              <ConfirmButton label="Maintenance off" pendingLabel="…"
                confirmMessage={`Take ${site.name} out of maintenance mode?`} />
            </form>
            <form action={flushCache}>
              <ConfirmButton label="Flush cache" pendingLabel="…"
                confirmMessage={`Flush the object cache on ${site.name}?`} />
            </form>
            <form action={flushPermalinks}>
              <ConfirmButton label="Flush permalinks" pendingLabel="…"
                confirmMessage={`Flush rewrite rules on ${site.name}?`} />
            </form>
          </div>
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Administrators</h2>
          {!inv?.admin_users?.length ? (
            <p className="text-sm text-slate-500">No inventory yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {inv.admin_users.map((u) => (
                <li key={u.ID} className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{u.user_login}</span>
                  <span className="text-slate-500">{u.user_email}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit` → 0 errors; `npm test` → green; `npm run build` → success.

```powershell
git add "src/app/(dashboard)/sites/[id]"; git commit -m "feat: themes tab, core update banner, tools card, and admins list"
```

---

### Task 9: Dashboard pending-updates + README updates

**Files:**
- Modify: `src/app/(dashboard)/dashboard/page.tsx`, `README.md`

**Interfaces:**
- Consumes: `supabaseSnapshotsRepo.latestSnapshot`, `pendingUpdates` (Task 4).
- Produces: dashboard cards showing pending-updates badge; README covering cron setup.

- [ ] **Step 1: Add pending updates to the dashboard**

Replace `src/app/(dashboard)/dashboard/page.tsx` content:
```tsx
import Link from "next/link";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { pendingUpdates } from "@/services/inventory/types";
import type { SiteStatus } from "@/services/sites/types";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<SiteStatus, string> = {
  connected: "bg-green-100 text-green-800",
  degraded: "bg-yellow-100 text-yellow-800",
  reconnect_needed: "bg-red-100 text-red-800",
  disabled: "bg-slate-200 text-slate-600",
};

export default async function DashboardPage() {
  const db = createServiceSupabase();
  const sites = await listSites({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient });
  const snapshots = supabaseSnapshotsRepo(db);
  const updates = new Map<string, number>();
  await Promise.all(sites.map(async (s) => {
    const snap = await snapshots.latestSnapshot(s.id);
    if (snap) updates.set(s.id, pendingUpdates(snap.payload));
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <h1 className="mb-6 text-2xl font-semibold">Sites</h1>
      {sites.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-white p-12 text-center text-slate-500">
          No sites connected yet.{" "}
          <Link href="/sites/new" className="text-slate-900 underline">Connect your first site</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((s) => {
            const n = updates.get(s.id);
            return (
              <Link key={s.id} href={`/sites/${s.id}`}
                className="rounded-lg border bg-white p-4 shadow-sm transition hover:shadow">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-medium">{s.name}</h2>
                    <p className="truncate text-sm text-slate-500">{s.url.replace(/^https?:\/\//, "")}</p>
                  </div>
                  <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[s.status]}`}>
                    {s.status.replace("_", " ")}
                  </span>
                </div>
                <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>{s.capabilities?.abilities?.length ?? 0} abilities</span>
                  {s.client_label && <span>· {s.client_label}</span>}
                  {n !== undefined && (n > 0
                    ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">{n} updates</span>
                    : <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-800">up to date</span>)}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Update README**

In `README.md`, replace the "Deploy (Vercel)" section with:
```markdown
## Deploy (Vercel)

Set the same env vars in Vercel (including `CRON_SECRET`). `vercel.json`
registers a daily backstop cron; the real schedules run from Supabase —
see `docs/ops/scheduling.md` for the one-time pg_cron + pg_net setup.

## Background jobs

- Nightly: `/api/cron/enqueue` inserts a `snapshot_refresh` job per site.
- Every minute: `/api/cron/process` claims up to 3 due jobs and runs them.
- Manual: every "Refresh inventory" button runs the same code path inline.
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit`; `npm test`; `npm run build` — all green.

```powershell
git add "src/app/(dashboard)/dashboard/page.tsx" README.md; git commit -m "feat: dashboard pending-updates badges and cron docs"
```

---

## Self-Review Notes

- **Spec coverage (Phase 2 scope):** inventory snapshots (T4), jobs system + backoff + dedupe (T1-T2), pg_cron/Vercel wiring (T5), update/activate/maintenance/cache/permalink actions (T6), Plugins/Themes tabs + confirm dialogs (T7-T8), dashboard updates badges (T9), activity logging on all mutations (T6 service; add-site/test-connection already log). Admin-user listing (spec §6.1) lands on the overview (T8). Bulk-across-sites installs are Phase 4 by spec; "update all plugins" per site is in scope here.
- **Type consistency:** `JobsRepo`/`JobHandlers` names match between T2 and T5/T6; `InventoryPayload`/`pendingUpdates` between T4 and T8/T9; `ManageAction` kinds between T6 and T7/T8 forms; `executeAbility(name, args, opts)` change in T3 is consumed by `runWpCli` only.
- **Judgment calls:** server-action `.bind()` results are cast for `<form action>` (same pattern the Phase 1 final review settled on); WP-CLI result parsing is defensive because Novamira's exact return shape varies; `core check-update` failures never fail a snapshot.
