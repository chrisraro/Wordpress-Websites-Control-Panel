# Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable Next.js + Supabase app where a team member can log in, connect a WordPress site via its Novamira MCP endpoint (credentials encrypted), and see all connected sites on a dashboard with per-site overview pages.

**Architecture:** Next.js 15 App Router monolith. All WordPress/MCP calls happen server-side through a thin `SiteMcpClient` wrapper around `@modelcontextprotocol/sdk`. Business logic lives in `src/services/*` behind narrow repo interfaces so it is unit-testable with in-memory fakes; route handlers and server actions stay thin. Supabase provides Postgres (full schema created now, later phases fill it), Auth (invite-only), and Storage (used from Phase 4 on).

**Tech Stack:** Next.js 15 (App Router, TS), Tailwind CSS v4, `@supabase/supabase-js` + `@supabase/ssr`, `@modelcontextprotocol/sdk` ^1.30, `libsodium-wrappers` (secretbox), `zod`, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md` — consult for any ambiguity.
- All MCP endpoints, credentials, and raw MCP responses are server-only. Nothing secret in client components, `NEXT_PUBLIC_*`, or serialized props.
- App passwords encrypted at rest with `APP_ENCRYPTION_KEY` (base64, 32 bytes) via libsodium secretbox. (Refines the spec's "libsodium sealed box" line — symmetric secretbox, same library, same env-held key property.)
- MCP clients: create per request/job, always `close()` in `finally`, 30s default timeout.
- Site status enum everywhere: `connected | degraded | reconnect_needed | disabled`.
- Every mutating action inserts an `activity_log` row with the acting user's auth uid.
- Public (unauthenticated) routes: `/login`, `/r/*`, `/api/cron/*`, `/api/webhooks/*`. Everything else requires a Supabase session.
- shadcn/ui and Playwright are deferred to Phase 2+; Phase 1 UI is plain Tailwind, tests are Vitest only.
- Node 20+. Package name: `wp-control-panel`.
- Commit after every task (steps say when). Windows/PowerShell environment — commands are PowerShell-safe (no `&&`).

## File Structure (end state of Phase 1)

```
package.json, tsconfig.json, next.config.ts, postcss.config.mjs, vitest.config.ts, .env.example, .gitignore
supabase/migrations/0001_init.sql
src/
  app/
    globals.css, layout.tsx, page.tsx            # root: redirect to /dashboard
    login/page.tsx, login/actions.ts
    (dashboard)/layout.tsx                        # auth-gated shell + nav + logout
    (dashboard)/dashboard/page.tsx                # site grid
    (dashboard)/sites/new/page.tsx, actions.ts    # add-site form + server action
    (dashboard)/sites/[id]/page.tsx, actions.ts   # overview tab + test-connection action
  middleware.ts
  lib/env.ts                                      # typed env access
  lib/crypto/secrets.ts                           # encryptSecret / decryptSecret
  lib/mcp/errors.ts, client.ts, mock.ts           # SiteMcpClient wrapper + typed errors + mock
  lib/supabase/server.ts, browser.ts              # SSR + service-role clients
  services/sites/repo.ts, service.ts, types.ts    # SitesRepo interface + supabase impl + logic
tests/
  crypto.test.ts, mcp-errors.test.ts, sites-service.test.ts
```

---

### Task 1: Project scaffold + test runner

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/lib/env.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: `getEnv(name: EnvName): string` from `@/lib/env` (throws if missing); path alias `@/* → src/*`; `npm test` (vitest run), `npm run dev`, `npm run build`.

- [ ] **Step 1: Write config + scaffold files**

`package.json`:
```json
{
  "name": "wp-control-panel",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Install (creates lockfile, fills dependencies):
```powershell
npm install next@15 react@19 react-dom@19 @supabase/supabase-js @supabase/ssr @modelcontextprotocol/sdk@^1.30 libsodium-wrappers zod
npm install -D typescript @types/react @types/react-dom @types/node @types/libsodium-wrappers vitest tailwindcss @tailwindcss/postcss postcss
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.ts`:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;
```

`postcss.config.mjs`:
```js
export default { plugins: { "@tailwindcss/postcss": {} } };
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

`.gitignore`:
```
node_modules/
.next/
.env*.local
.env
*.tsbuildinfo
next-env.d.ts
```

`.env.example`:
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# base64-encoded 32 random bytes; generate with:
# node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
APP_ENCRYPTION_KEY=
```

`src/app/globals.css`:
```css
@import "tailwindcss";
```

`src/app/layout.tsx`:
```tsx
import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "WP Control Panel" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
```

`src/app/page.tsx`:
```tsx
import { redirect } from "next/navigation";
export default function Home() {
  redirect("/dashboard");
}
```

`src/lib/env.ts`:
```ts
const NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APP_ENCRYPTION_KEY",
] as const;

export type EnvName = (typeof NAMES)[number];

export function getEnv(name: EnvName): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
```

- [ ] **Step 2: Write a smoke test**

`tests/smoke.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { getEnv } from "@/lib/env";

describe("env", () => {
  afterEach(() => delete process.env.APP_ENCRYPTION_KEY);

  it("returns a set env var", () => {
    process.env.APP_ENCRYPTION_KEY = "abc";
    expect(getEnv("APP_ENCRYPTION_KEY")).toBe("abc");
  });

  it("throws on missing env var", () => {
    expect(() => getEnv("APP_ENCRYPTION_KEY")).toThrow(/Missing required env var/);
  });
});
```

- [ ] **Step 3: Verify tests and build pass**

Run: `npm test` → expect 2 passing.
Run: `npm run build` → expect successful production build (a `/dashboard` 404 is fine at this point; the redirect target arrives in Task 6).

- [ ] **Step 4: Commit**

```powershell
git add -A; git commit -m "feat: scaffold Next.js 15 app with Tailwind v4 and Vitest"
```

---

### Task 2: Supabase schema migration (full spec schema + RLS)

**Files:**
- Create: `supabase/migrations/0001_init.sql`

**Interfaces:**
- Produces: all tables from spec §5. Phase 1 code uses only `sites` and `activity_log`; later phases use the rest without new migrations.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0001_init.sql`:
```sql
-- Enums
create type site_status as enum ('connected','degraded','reconnect_needed','disabled');
create type job_status as enum ('pending','running','awaiting_callback','done','failed');
create type check_result as enum ('pass','fail','warn');
create type vuln_status as enum ('open','fixed','ignored');

-- Sites
create table sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  mcp_endpoint text not null,
  wp_username text not null,
  app_password_encrypted text not null,
  status site_status not null default 'connected',
  client_label text,
  capabilities jsonb not null default '{}'::jsonb,
  consecutive_failures int not null default 0,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (url)
);

create table site_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  taken_at timestamptz not null default now(),
  payload jsonb not null
);
create index on site_snapshots (site_id, taken_at desc);

create table vuln_feed (
  id text primary key,
  software_slug text not null,
  software_type text not null,
  affected_versions jsonb not null,
  cve text,
  cvss numeric,
  title text,
  fixed_in text,
  updated_at timestamptz not null default now()
);
create index on vuln_feed (software_slug, software_type);

create table site_vulnerabilities (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  feed_id text not null references vuln_feed(id),
  component text not null,
  installed_version text not null,
  severity text,
  status vuln_status not null default 'open',
  first_seen timestamptz not null default now(),
  unique (site_id, feed_id, component)
);

create table security_checks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  run_at timestamptz not null default now(),
  check_id text not null,
  result check_result not null,
  details jsonb
);
create index on security_checks (site_id, run_at desc);

create table uptime_checks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  checked_at timestamptz not null default now(),
  http_status int,
  response_ms int,
  ssl_days_remaining int,
  ok boolean not null
);
create index on uptime_checks (site_id, checked_at desc);

create table seo_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  taken_at timestamptz not null default now(),
  source text not null,
  payload jsonb not null
);
create index on seo_snapshots (site_id, source, taken_at desc);

create table geogrid_configs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  business_name text not null,
  place_ref text,
  keywords text[] not null default '{}',
  grid_size int not null default 7 check (grid_size in (3,5,7,9)),
  spacing_m int not null default 1000,
  center_lat double precision not null,
  center_lng double precision not null,
  provider text not null default 'stub' check (provider in ('stub','n8n')),
  created_at timestamptz not null default now()
);

create table geogrid_snapshots (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references geogrid_configs(id) on delete cascade,
  run_at timestamptz not null default now(),
  keyword text not null,
  points jsonb not null
);
create index on geogrid_snapshots (config_id, run_at desc);

create table reports (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  generated_at timestamptz not null default now(),
  sections text[] not null,
  period_start date,
  period_end date,
  storage_path text not null,
  share_token text unique,
  auto boolean not null default false
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  site_id uuid references sites(id) on delete cascade,
  batch_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status job_status not null default 'pending',
  attempts int not null default 0,
  scheduled_for timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text
);
create index on jobs (status, scheduled_for);
create index on jobs (batch_id) where batch_id is not null;

create table activity_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid not null,
  site_id uuid references sites(id) on delete set null,
  action text not null,
  detail jsonb,
  at timestamptz not null default now()
);
create index on activity_log (site_id, at desc);

-- updated_at trigger for sites
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger sites_updated_at before update on sites
  for each row execute function set_updated_at();

-- RLS: team-only. Authenticated users get full access; anon gets nothing.
-- (Server-side cron/service code uses the service role key, which bypasses RLS.)
do $$
declare t text;
begin
  foreach t in array array[
    'sites','site_snapshots','vuln_feed','site_vulnerabilities','security_checks',
    'uptime_checks','seo_snapshots','geogrid_configs','geogrid_snapshots',
    'reports','jobs','activity_log'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy team_all on %I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;
```

- [ ] **Step 2: Apply to Supabase (manual gate)**

Preferred, with Supabase CLI installed and project linked:
```powershell
npx supabase db push
```
Fallback: paste the SQL into the Supabase dashboard SQL editor and run it.
Also (manual, dashboard): **Authentication → Sign In / Up → disable "Allow new users to sign up"**, then invite the team by email (invite-only auth per spec). Create at least one user for yourself now — the login flow in Task 5 needs it.

Expected: all statements succeed; `sites` visible in Table Editor with RLS enabled.

- [ ] **Step 3: Commit**

```powershell
git add supabase; git commit -m "feat: initial Supabase schema with RLS (full spec data model)"
```

---

### Task 3: Secret encryption module (TDD)

**Files:**
- Create: `src/lib/crypto/secrets.ts`
- Test: `tests/crypto.test.ts`

**Interfaces:**
- Consumes: `getEnv("APP_ENCRYPTION_KEY")` from Task 1.
- Produces: `encryptSecret(plaintext: string): Promise<string>` and `decryptSecret(ciphertext: string): Promise<string>` from `@/lib/crypto/secrets`. Ciphertext format: `base64(nonce ‖ secretbox)`. Throws `Error("Decryption failed")` on tamper/wrong key.

- [ ] **Step 1: Write the failing test**

`tests/crypto.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("secrets", () => {
  it("round-trips a value", async () => {
    const ct = await encryptSecret("hunter2 app pass");
    expect(ct).not.toContain("hunter2");
    expect(await decryptSecret(ct)).toBe("hunter2 app pass");
  });

  it("produces different ciphertexts for same plaintext (random nonce)", async () => {
    expect(await encryptSecret("x")).not.toBe(await encryptSecret("x"));
  });

  it("throws on tampered ciphertext", async () => {
    const ct = await encryptSecret("x");
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0xff;
    await expect(decryptSecret(buf.toString("base64"))).rejects.toThrow("Decryption failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/crypto.test.ts`
Expected: FAIL — cannot resolve `@/lib/crypto/secrets`.

- [ ] **Step 3: Implement**

`src/lib/crypto/secrets.ts`:
```ts
import sodium from "libsodium-wrappers";
import { getEnv } from "@/lib/env";

async function key(): Promise<Uint8Array> {
  await sodium.ready;
  const raw = Buffer.from(getEnv("APP_ENCRYPTION_KEY"), "base64");
  if (raw.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }
  return new Uint8Array(raw);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const k = await key();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, k);
  return Buffer.concat([nonce, box]).toString("base64");
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  const k = await key();
  const raw = Buffer.from(ciphertext, "base64");
  const nonce = new Uint8Array(raw.subarray(0, sodium.crypto_secretbox_NONCEBYTES));
  const box = new Uint8Array(raw.subarray(sodium.crypto_secretbox_NONCEBYTES));
  try {
    return sodium.to_string(sodium.crypto_secretbox_open_easy(box, nonce, k));
  } catch {
    throw new Error("Decryption failed");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/crypto.test.ts` → expect 3 passing.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/crypto tests/crypto.test.ts; git commit -m "feat: libsodium secretbox encryption for site credentials"
```

---

### Task 4: MCP client wrapper, typed errors, and mock (TDD on error mapping)

**Files:**
- Create: `src/lib/mcp/errors.ts`, `src/lib/mcp/client.ts`, `src/lib/mcp/mock.ts`
- Test: `tests/mcp-errors.test.ts`

**Interfaces:**
- Produces (used by Tasks 6–8 and every later phase):

```ts
// errors.ts
export class McpError extends Error {}
export class McpConnectionError extends McpError {}   // unreachable / TLS / timeout
export class McpAuthError extends McpError {}          // 401/403 — app password rejected
export class McpAbilityMissingError extends McpError { constructor(public ability: string) }
export class McpToolError extends McpError {}          // tool ran, returned isError/stderr
export function mapConnectError(e: unknown): McpError; // classifies SDK/fetch failures

// client.ts
export interface DiscoveredAbility { name: string; label?: string; description?: string }
export interface DiscoveredAbilities { abilities: DiscoveredAbility[]; instructions?: string }
export interface SiteMcpClient {
  listToolNames(): Promise<string[]>;
  discoverAbilities(): Promise<DiscoveredAbilities>;
  executeAbility(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export interface McpConnectOptions {
  endpoint: string; username: string; appPassword: string; timeoutMs?: number; // default 30000
}
export type McpFactory = (opts: McpConnectOptions) => Promise<SiteMcpClient>;
export const createSiteMcpClient: McpFactory;

// mock.ts
export class MockMcpClient implements SiteMcpClient // constructor(config?: {abilities?: DiscoveredAbility[]; failWith?: Error; results?: Record<string, unknown>})
```

- [ ] **Step 1: Write the failing tests for error mapping and the mock**

`tests/mcp-errors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  mapConnectError, McpAuthError, McpConnectionError, McpError,
} from "@/lib/mcp/errors";
import { MockMcpClient } from "@/lib/mcp/mock";

describe("mapConnectError", () => {
  it("maps HTTP 401 to McpAuthError", () => {
    expect(mapConnectError(new Error("Error POSTing to endpoint (HTTP 401): unauthorized")))
      .toBeInstanceOf(McpAuthError);
  });
  it("maps HTTP 403 to McpAuthError", () => {
    expect(mapConnectError(new Error("HTTP 403"))).toBeInstanceOf(McpAuthError);
  });
  it("maps fetch/network failures to McpConnectionError", () => {
    expect(mapConnectError(new TypeError("fetch failed"))).toBeInstanceOf(McpConnectionError);
    expect(mapConnectError(new Error("getaddrinfo ENOTFOUND site.test")))
      .toBeInstanceOf(McpConnectionError);
    expect(mapConnectError(new Error("The operation was aborted due to timeout")))
      .toBeInstanceOf(McpConnectionError);
  });
  it("wraps anything else as McpError", () => {
    const e = mapConnectError("weird");
    expect(e).toBeInstanceOf(McpError);
  });
});

describe("MockMcpClient", () => {
  it("returns configured abilities and results", async () => {
    const mock = new MockMcpClient({
      abilities: [{ name: "novamira/run-wp-cli" }],
      results: { "novamira/run-wp-cli": { stdout: "5.0.0" } },
    });
    const d = await mock.discoverAbilities();
    expect(d.abilities.map((a) => a.name)).toContain("novamira/run-wp-cli");
    expect(await mock.executeAbility("novamira/run-wp-cli", { command: "core version" }))
      .toEqual({ stdout: "5.0.0" });
    expect(mock.calls).toEqual([{ name: "novamira/run-wp-cli", args: { command: "core version" } }]);
  });

  it("throws configured failure on connect-style use", async () => {
    const mock = new MockMcpClient({ failWith: new McpAuthError("rejected") });
    await expect(mock.discoverAbilities()).rejects.toBeInstanceOf(McpAuthError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/mcp-errors.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement errors, client, mock**

`src/lib/mcp/errors.ts`:
```ts
export class McpError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}
export class McpConnectionError extends McpError {}
export class McpAuthError extends McpError {}
export class McpAbilityMissingError extends McpError {
  constructor(public ability: string) {
    super(`Site does not support ability: ${ability}`);
  }
}
export class McpToolError extends McpError {}

export function mapConnectError(e: unknown): McpError {
  if (e instanceof McpError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/\b(401|403)\b|unauthorized|forbidden/i.test(msg)) return new McpAuthError(msg, e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|certificate|aborted|timeout/i.test(msg)) {
    return new McpConnectionError(msg, e);
  }
  return new McpError(msg, e);
}
```

`src/lib/mcp/client.ts`:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mapConnectError, McpToolError } from "./errors";

export interface DiscoveredAbility { name: string; label?: string; description?: string }
export interface DiscoveredAbilities { abilities: DiscoveredAbility[]; instructions?: string }

export interface SiteMcpClient {
  listToolNames(): Promise<string[]>;
  discoverAbilities(): Promise<DiscoveredAbilities>;
  executeAbility(name: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpConnectOptions {
  endpoint: string;
  username: string;
  appPassword: string;
  timeoutMs?: number;
}

export type McpFactory = (opts: McpConnectOptions) => Promise<SiteMcpClient>;

const DEFAULT_TIMEOUT = 30_000;

/** Extract the JSON payload from an MCP tool result's content blocks. */
function parseToolResult(result: { content?: unknown; isError?: boolean }): unknown {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  if (result.isError) throw new McpToolError(text || "MCP tool returned an error");
  try { return JSON.parse(text); } catch { return text; }
}

export const createSiteMcpClient: McpFactory = async (opts) => {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const basic = Buffer.from(`${opts.username}:${opts.appPassword}`).toString("base64");
  const transport = new StreamableHTTPClientTransport(new URL(opts.endpoint), {
    requestInit: { headers: { Authorization: `Basic ${basic}` } },
  });
  const client = new Client({ name: "wp-control-panel", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (e) {
    throw mapConnectError(e);
  }

  return {
    async listToolNames() {
      try {
        const { tools } = await client.listTools(undefined, { timeout });
        return tools.map((t) => t.name);
      } catch (e) { throw mapConnectError(e); }
    },
    async discoverAbilities() {
      try {
        const res = await client.callTool(
          { name: "mcp-adapter-discover-abilities", arguments: {} }, undefined, { timeout },
        );
        const parsed = parseToolResult(res) as {
          abilities?: DiscoveredAbility[]; novamira_instructions?: string;
        };
        return { abilities: parsed.abilities ?? [], instructions: parsed.novamira_instructions };
      } catch (e) { throw mapConnectError(e); }
    },
    async executeAbility(name, args = {}) {
      try {
        const res = await client.callTool(
          { name: "mcp-adapter-execute-ability", arguments: { ability_name: name, parameters: args } },
          undefined, { timeout },
        );
        return parseToolResult(res);
      } catch (e) { throw mapConnectError(e); }
    },
    async close() {
      try { await client.close(); } catch { /* best effort */ }
    },
  };
};
```

`src/lib/mcp/mock.ts`:
```ts
import type { DiscoveredAbilities, DiscoveredAbility, SiteMcpClient } from "./client";

export class MockMcpClient implements SiteMcpClient {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = false;

  constructor(
    private config: {
      abilities?: DiscoveredAbility[];
      failWith?: Error;
      results?: Record<string, unknown>;
    } = {},
  ) {}

  private failIfConfigured() {
    if (this.config.failWith) throw this.config.failWith;
  }

  async listToolNames(): Promise<string[]> {
    this.failIfConfigured();
    return ["mcp-adapter-discover-abilities", "mcp-adapter-execute-ability"];
  }

  async discoverAbilities(): Promise<DiscoveredAbilities> {
    this.failIfConfigured();
    return { abilities: this.config.abilities ?? [], instructions: undefined };
  }

  async executeAbility(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.failIfConfigured();
    this.calls.push({ name, args });
    return this.config.results?.[name] ?? null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/mcp-errors.test.ts` → expect all passing.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/mcp tests/mcp-errors.test.ts; git commit -m "feat: MCP client wrapper with typed errors and test mock"
```

---

### Task 5: Supabase clients, auth middleware, login/logout

**Files:**
- Create: `src/lib/supabase/server.ts`, `src/lib/supabase/browser.ts`, `src/middleware.ts`, `src/app/login/page.tsx`, `src/app/login/actions.ts`

**Interfaces:**
- Consumes: `getEnv` (Task 1).
- Produces:
  - `createServerSupabase(): Promise<SupabaseClient>` — cookie-bound SSR client (RLS as the logged-in user)
  - `createServiceSupabase(): SupabaseClient` — service-role client, server-only, for repos/cron
  - `requireUser(): Promise<User>` — throws redirect to `/login` if no session
  - Server actions: `login(formData)`, `logout()`

- [ ] **Step 1: Implement Supabase helpers**

`src/lib/supabase/server.ts`:
```ts
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";

export async function createServerSupabase(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createServerClient(
    getEnv("NEXT_PUBLIC_SUPABASE_URL"),
    getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch { /* called from a Server Component — middleware refreshes sessions */ }
        },
      },
    },
  );
}

export function createServiceSupabase(): SupabaseClient {
  return createClient(getEnv("NEXT_PUBLIC_SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

export async function requireUser(): Promise<User> {
  const supabase = await createServerSupabase();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  return data.user;
}
```

`src/lib/supabase/browser.ts`:
```ts
import { createBrowserClient } from "@supabase/ssr";

export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

- [ ] **Step 2: Implement middleware**

`src/middleware.ts`:
```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PREFIXES = ["/login", "/r/", "/api/cron/", "/api/webhooks/"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data } = await supabase.auth.getUser();
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));

  if (!data.user && !isPublic) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (data.user && pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)"],
};
```

- [ ] **Step 3: Implement login page + actions**

`src/app/login/actions.ts`:
```ts
"use server";

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";

export async function login(_prev: { error?: string } | undefined, formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "Invalid email or password" };
  redirect("/dashboard");
}

export async function logout() {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}
```

`src/app/login/page.tsx`:
```tsx
"use client";

import { useActionState } from "react";
import { login } from "./actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form action={action} className="w-full max-w-sm space-y-4 rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">WP Control Panel</h1>
        <input name="email" type="email" required placeholder="Email"
          className="w-full rounded border px-3 py-2" />
        <input name="password" type="password" required placeholder="Password"
          className="w-full rounded border px-3 py-2" />
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
        <button disabled={pending}
          className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50">
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Manual verification**

Create `.env.local` from `.env.example` with real Supabase values and a generated `APP_ENCRYPTION_KEY`. Run `npm run dev`, then:
1. Visit `http://localhost:3000/` → redirected to `/login` (dashboard doesn't exist yet — after login expect its 404; that's fine until Task 6).
2. Log in with the user invited in Task 2 → redirected away from `/login`.
3. Visit `/login` while signed in → bounced to `/dashboard`.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/supabase src/middleware.ts src/app/login; git commit -m "feat: Supabase auth with SSR clients, middleware, and login"
```

---

### Task 6: Sites service — repo interface, add/list/get/test-connection (TDD)

**Files:**
- Create: `src/services/sites/types.ts`, `src/services/sites/repo.ts`, `src/services/sites/service.ts`
- Test: `tests/sites-service.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (Task 3), `McpFactory`, `SiteMcpClient`, MCP error classes (Task 4), `createServiceSupabase` (Task 5).
- Produces (used by Tasks 7–8 and later phases):

```ts
// types.ts
export type SiteStatus = "connected" | "degraded" | "reconnect_needed" | "disabled";
export interface SiteRow {
  id: string; name: string; url: string; mcp_endpoint: string; wp_username: string;
  status: SiteStatus; client_label: string | null;
  capabilities: { abilities: string[] }; created_at: string; updated_at: string;
}
export interface NewSiteInput {
  name: string; url: string; wpUsername: string; appPassword: string; clientLabel?: string;
}

// repo.ts
export interface SitesRepo {
  insertSite(row: {...}): Promise<{ id: string }>;
  listSites(): Promise<SiteRow[]>;
  getSite(id: string): Promise<SiteRow | null>;
  getSiteCredentials(id: string): Promise<{ mcp_endpoint: string; wp_username: string; app_password_encrypted: string } | null>;
  updateSiteStatus(id: string, status: SiteStatus): Promise<void>;
  insertActivity(entry: { actor: string; site_id?: string; action: string; detail?: unknown }): Promise<void>;
}
export function supabaseSitesRepo(db: SupabaseClient): SitesRepo;

// service.ts
export interface SitesDeps { repo: SitesRepo; mcp: McpFactory }
export function addSite(deps: SitesDeps, input: NewSiteInput, actorId: string): Promise<{ id: string }>;
export function listSites(deps: SitesDeps): Promise<SiteRow[]>;
export function getSite(deps: SitesDeps, id: string): Promise<SiteRow | null>;
export function testSiteConnection(deps: SitesDeps, id: string, actorId: string): Promise<{ ok: boolean; status: SiteStatus; error?: string }>;
export function mcpEndpointFor(url: string): string; // https://<host>/wp-json/mcp/novamira
```

- [ ] **Step 1: Write the failing tests**

`tests/sites-service.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { addSite, testSiteConnection, mcpEndpointFor } from "@/services/sites/service";
import type { SitesRepo } from "@/services/sites/repo";
import type { SiteRow, SiteStatus } from "@/services/sites/types";
import { MockMcpClient } from "@/lib/mcp/mock";
import { McpAuthError, McpConnectionError } from "@/lib/mcp/errors";
import { decryptSecret } from "@/lib/crypto/secrets";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

function memoryRepo() {
  const sites: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];
  const repo: SitesRepo = {
    async insertSite(row) {
      const id = `site-${sites.length + 1}`;
      sites.push({ id, status: "connected", ...row });
      return { id };
    },
    async listSites() { return sites as unknown as SiteRow[]; },
    async getSite(id) { return (sites.find((s) => s.id === id) as unknown as SiteRow) ?? null; },
    async getSiteCredentials(id) {
      const s = sites.find((x) => x.id === id);
      return s
        ? {
            mcp_endpoint: s.mcp_endpoint as string,
            wp_username: s.wp_username as string,
            app_password_encrypted: s.app_password_encrypted as string,
          }
        : null;
    },
    async updateSiteStatus(id, status: SiteStatus) {
      const s = sites.find((x) => x.id === id);
      if (s) s.status = status;
    },
    async insertActivity(entry) { activity.push(entry); },
  };
  return { repo, sites, activity };
}

const INPUT = {
  name: "El Nido Guide", url: "https://elnidoguide.ph",
  wpUsername: "admin", appPassword: "aaaa bbbb cccc dddd",
};

describe("mcpEndpointFor", () => {
  it("derives the Novamira endpoint from a site URL", () => {
    expect(mcpEndpointFor("https://elnidoguide.ph")).toBe("https://elnidoguide.ph/wp-json/mcp/novamira");
    expect(mcpEndpointFor("https://elnidoguide.ph/")).toBe("https://elnidoguide.ph/wp-json/mcp/novamira");
  });
});

describe("addSite", () => {
  it("verifies MCP, stores encrypted password + capabilities, logs activity", async () => {
    const { repo, sites, activity } = memoryRepo();
    const mcp = async () =>
      new MockMcpClient({ abilities: [{ name: "novamira/run-wp-cli" }, { name: "rank-math/audit-site-seo" }] });

    const { id } = await addSite({ repo, mcp }, INPUT, "user-1");

    expect(id).toBe("site-1");
    const row = sites[0];
    expect(row.app_password_encrypted).not.toContain("aaaa");
    expect(await decryptSecret(row.app_password_encrypted as string)).toBe(INPUT.appPassword);
    expect((row.capabilities as { abilities: string[] }).abilities).toContain("novamira/run-wp-cli");
    expect(activity[0]).toMatchObject({ actor: "user-1", action: "site.connect" });
  });

  it("rejects with a friendly error when auth fails, and stores nothing", async () => {
    const { repo, sites } = memoryRepo();
    const mcp = async () => new MockMcpClient({ failWith: new McpAuthError("401") });
    await expect(addSite({ repo, mcp }, INPUT, "user-1")).rejects.toThrow(/application password/i);
    expect(sites).toHaveLength(0);
  });
});

describe("testSiteConnection", () => {
  it("marks reconnect_needed on auth failure", async () => {
    const { repo, sites } = memoryRepo();
    await addSite({ repo, mcp: async () => new MockMcpClient() }, INPUT, "user-1");
    const failing = async () => new MockMcpClient({ failWith: new McpAuthError("401") });
    const res = await testSiteConnection({ repo, mcp: failing }, "site-1", "user-1");
    expect(res).toMatchObject({ ok: false, status: "reconnect_needed" });
    expect(sites[0].status).toBe("reconnect_needed");
  });

  it("marks degraded on connection failure and connected on success", async () => {
    const { repo, sites } = memoryRepo();
    await addSite({ repo, mcp: async () => new MockMcpClient() }, INPUT, "user-1");
    const down = async () => new MockMcpClient({ failWith: new McpConnectionError("ENOTFOUND") });
    expect((await testSiteConnection({ repo, mcp: down }, "site-1", "u")).status).toBe("degraded");
    expect((await testSiteConnection({ repo, mcp: async () => new MockMcpClient() }, "site-1", "u")).status)
      .toBe("connected");
    expect(sites[0].status).toBe("connected");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/sites-service.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement types, repo, service**

`src/services/sites/types.ts`:
```ts
export type SiteStatus = "connected" | "degraded" | "reconnect_needed" | "disabled";

export interface SiteRow {
  id: string;
  name: string;
  url: string;
  mcp_endpoint: string;
  wp_username: string;
  status: SiteStatus;
  client_label: string | null;
  capabilities: { abilities: string[] };
  created_at: string;
  updated_at: string;
}

export interface NewSiteInput {
  name: string;
  url: string;
  wpUsername: string;
  appPassword: string;
  clientLabel?: string;
}
```

`src/services/sites/repo.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiteRow, SiteStatus } from "./types";

export interface SitesRepo {
  insertSite(row: {
    name: string; url: string; mcp_endpoint: string; wp_username: string;
    app_password_encrypted: string; client_label: string | null;
    capabilities: { abilities: string[] }; created_by: string;
  }): Promise<{ id: string }>;
  listSites(): Promise<SiteRow[]>;
  getSite(id: string): Promise<SiteRow | null>;
  getSiteCredentials(id: string): Promise<{
    mcp_endpoint: string; wp_username: string; app_password_encrypted: string;
  } | null>;
  updateSiteStatus(id: string, status: SiteStatus): Promise<void>;
  insertActivity(entry: {
    actor: string; site_id?: string; action: string; detail?: unknown;
  }): Promise<void>;
}

const SITE_COLUMNS =
  "id,name,url,mcp_endpoint,wp_username,status,client_label,capabilities,created_at,updated_at";

export function supabaseSitesRepo(db: SupabaseClient): SitesRepo {
  return {
    async insertSite(row) {
      const { data, error } = await db.from("sites").insert(row).select("id").single();
      if (error) throw new Error(`insertSite failed: ${error.message}`);
      return { id: data.id };
    },
    async listSites() {
      const { data, error } = await db.from("sites").select(SITE_COLUMNS).order("name");
      if (error) throw new Error(`listSites failed: ${error.message}`);
      return (data ?? []) as SiteRow[];
    },
    async getSite(id) {
      const { data, error } = await db.from("sites").select(SITE_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw new Error(`getSite failed: ${error.message}`);
      return (data as SiteRow) ?? null;
    },
    async getSiteCredentials(id) {
      const { data, error } = await db
        .from("sites")
        .select("mcp_endpoint,wp_username,app_password_encrypted")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`getSiteCredentials failed: ${error.message}`);
      return data ?? null;
    },
    async updateSiteStatus(id, status) {
      const { error } = await db.from("sites").update({ status }).eq("id", id);
      if (error) throw new Error(`updateSiteStatus failed: ${error.message}`);
    },
    async insertActivity(entry) {
      const { error } = await db.from("activity_log").insert({
        actor: entry.actor,
        site_id: entry.site_id ?? null,
        action: entry.action,
        detail: entry.detail ?? null,
      });
      if (error) throw new Error(`insertActivity failed: ${error.message}`);
    },
  };
}
```

`src/services/sites/service.ts`:
```ts
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
import { McpAuthError, McpConnectionError } from "@/lib/mcp/errors";
import type { McpFactory } from "@/lib/mcp/client";
import type { SitesRepo } from "./repo";
import type { NewSiteInput, SiteRow, SiteStatus } from "./types";

export interface SitesDeps {
  repo: SitesRepo;
  mcp: McpFactory;
}

export function mcpEndpointFor(url: string): string {
  return `${url.replace(/\/+$/, "")}/wp-json/mcp/novamira`;
}

export async function addSite(
  deps: SitesDeps, input: NewSiteInput, actorId: string,
): Promise<{ id: string }> {
  const endpoint = mcpEndpointFor(input.url);
  let abilities: string[];
  const client = await connectOrExplain(deps.mcp, endpoint, input.wpUsername, input.appPassword);
  try {
    const discovered = await client.discoverAbilities();
    abilities = discovered.abilities.map((a) => a.name);
  } catch (e) {
    throw explain(e);
  } finally {
    await client.close();
  }

  const { id } = await deps.repo.insertSite({
    name: input.name,
    url: input.url.replace(/\/+$/, ""),
    mcp_endpoint: endpoint,
    wp_username: input.wpUsername,
    app_password_encrypted: await encryptSecret(input.appPassword),
    client_label: input.clientLabel ?? null,
    capabilities: { abilities },
    created_by: actorId,
  });
  await deps.repo.insertActivity({
    actor: actorId, site_id: id, action: "site.connect",
    detail: { url: input.url, abilities: abilities.length },
  });
  return { id };
}

export async function listSites(deps: SitesDeps): Promise<SiteRow[]> {
  return deps.repo.listSites();
}

export async function getSite(deps: SitesDeps, id: string): Promise<SiteRow | null> {
  return deps.repo.getSite(id);
}

export async function testSiteConnection(
  deps: SitesDeps, id: string, actorId: string,
): Promise<{ ok: boolean; status: SiteStatus; error?: string }> {
  const creds = await deps.repo.getSiteCredentials(id);
  if (!creds) return { ok: false, status: "disabled", error: "Site not found" };

  let status: SiteStatus = "connected";
  let errorMsg: string | undefined;
  try {
    const client = await deps.mcp({
      endpoint: creds.mcp_endpoint,
      username: creds.wp_username,
      appPassword: await decryptSecret(creds.app_password_encrypted),
    });
    try {
      await client.discoverAbilities();
    } finally {
      await client.close();
    }
  } catch (e) {
    if (e instanceof McpAuthError) {
      status = "reconnect_needed";
      errorMsg = "Application password was rejected — reconnect the site.";
    } else if (e instanceof McpConnectionError) {
      status = "degraded";
      errorMsg = "Site is unreachable.";
    } else {
      status = "degraded";
      errorMsg = e instanceof Error ? e.message : String(e);
    }
  }

  await deps.repo.updateSiteStatus(id, status);
  await deps.repo.insertActivity({
    actor: actorId, site_id: id, action: "site.test_connection",
    detail: { ok: !errorMsg, status, error: errorMsg },
  });
  return { ok: !errorMsg, status, error: errorMsg };
}

function explain(e: unknown): Error {
  if (e instanceof McpAuthError) {
    return new Error("WordPress rejected the application password. Check the username and app password.");
  }
  if (e instanceof McpConnectionError) {
    return new Error("Could not reach the site's MCP endpoint. Is Novamira active and the URL correct?");
  }
  return e instanceof Error ? e : new Error(String(e));
}

async function connectOrExplain(
  mcp: McpFactory, endpoint: string, username: string, appPassword: string,
) {
  try {
    return await mcp({ endpoint, username, appPassword });
  } catch (e) {
    throw explain(e);
  }
}
```

Note: `MockMcpClient({failWith})` throws from `discoverAbilities()`, not from the factory — both paths route through `explain`, so the tests cover the friendly messages either way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → expect the full suite green.

- [ ] **Step 5: Commit**

```powershell
git add src/services tests/sites-service.test.ts; git commit -m "feat: sites service with connect/verify, encryption, and status transitions"
```

---

### Task 7: Add-site UI (form + server action)

**Files:**
- Create: `src/app/(dashboard)/sites/new/page.tsx`, `src/app/(dashboard)/sites/new/actions.ts`

**Interfaces:**
- Consumes: `addSite`, `mcpEndpointFor` (Task 6), `supabaseSitesRepo` (Task 6), `createServiceSupabase`, `requireUser` (Task 5), `createSiteMcpClient` (Task 4).
- Produces: route `/sites/new`; server action `createSite(prevState, formData)` returning `{ error?: string }` or redirecting to `/sites/[id]`.

- [ ] **Step 1: Implement the server action**

`src/app/(dashboard)/sites/new/actions.ts`:
```ts
"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { addSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().url("Enter a full URL, e.g. https://example.com"),
  wpUsername: z.string().min(1, "WordPress username is required"),
  appPassword: z.string().min(8, "Application password looks too short"),
  clientLabel: z.string().optional(),
});

export async function createSite(_prev: { error?: string } | undefined, formData: FormData) {
  const user = await requireUser();
  const parsed = schema.safeParse({
    name: formData.get("name"),
    url: formData.get("url"),
    wpUsername: formData.get("wpUsername"),
    appPassword: formData.get("appPassword"),
    clientLabel: formData.get("clientLabel") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const repo = supabaseSitesRepo(createServiceSupabase());
  let id: string;
  try {
    ({ id } = await addSite({ repo, mcp: createSiteMcpClient }, parsed.data, user.id));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to connect site" };
  }
  redirect(`/sites/${id}`);
}
```

- [ ] **Step 2: Implement the form page**

`src/app/(dashboard)/sites/new/page.tsx`:
```tsx
"use client";

import { useActionState } from "react";
import { createSite } from "./actions";

const field = "w-full rounded border px-3 py-2";

export default function NewSitePage() {
  const [state, action, pending] = useActionState(createSite, undefined);
  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-2xl font-semibold">Connect a WordPress site</h1>
      <form action={action} className="space-y-4 rounded-lg border bg-white p-6 shadow-sm">
        <label className="block text-sm font-medium">Site name
          <input name="name" required placeholder="El Nido Guide" className={field} />
        </label>
        <label className="block text-sm font-medium">Site URL
          <input name="url" type="url" required placeholder="https://example.com" className={field} />
        </label>
        <label className="block text-sm font-medium">WordPress username
          <input name="wpUsername" required className={field} />
        </label>
        <label className="block text-sm font-medium">Application password
          <input name="appPassword" type="password" required className={field} />
          <span className="text-xs font-normal text-slate-500">
            WP Admin → Users → Profile → Application Passwords. Requires the Novamira plugin active.
          </span>
        </label>
        <label className="block text-sm font-medium">Client label (optional)
          <input name="clientLabel" className={field} />
        </label>
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
        <button disabled={pending}
          className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
          {pending ? "Verifying connection…" : "Connect site"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Manual verification**

`npm run dev`, log in, open `/sites/new`:
1. Submit an invalid URL → inline zod error.
2. Submit a fake site (`https://nonexistent.example`) → "Could not reach the site's MCP endpoint…".
3. Submit a real Novamira site with a valid Application Password → redirect to `/sites/[id]` (404 until Task 8 — the redirect itself is the success signal). Confirm in Supabase Table Editor: `sites` row exists, `app_password_encrypted` is opaque base64, `capabilities.abilities` is populated, `activity_log` has a `site.connect` row.

- [ ] **Step 4: Commit**

```powershell
git add "src/app/(dashboard)/sites/new"; git commit -m "feat: add-site flow with MCP verification"
```

---

### Task 8: Dashboard shell, site grid, and site overview page

**Files:**
- Create: `src/app/(dashboard)/layout.tsx`, `src/app/(dashboard)/dashboard/page.tsx`, `src/app/(dashboard)/sites/[id]/page.tsx`, `src/app/(dashboard)/sites/[id]/actions.ts`

**Interfaces:**
- Consumes: `listSites`, `getSite`, `testSiteConnection` (Task 6), `supabaseSitesRepo`, `createServiceSupabase`, `requireUser`, `logout` (Task 5), `createSiteMcpClient` (Task 4), `SiteStatus` (Task 6).
- Produces: routes `/dashboard` and `/sites/[id]`; server action `runConnectionTest(siteId)`.

- [ ] **Step 1: Implement the dashboard layout (nav + logout)**

`src/app/(dashboard)/layout.tsx`:
```tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div>
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <nav className="flex items-center gap-6">
          <Link href="/dashboard" className="font-semibold">WP Control Panel</Link>
          <Link href="/sites/new" className="text-sm text-slate-600 hover:text-slate-900">
            + Connect site
          </Link>
        </nav>
        <form action={logout} className="flex items-center gap-3 text-sm text-slate-600">
          <span>{user.email}</span>
          <button className="rounded border px-2 py-1 hover:bg-slate-100">Sign out</button>
        </form>
      </header>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Implement the site grid**

`src/app/(dashboard)/dashboard/page.tsx`:
```tsx
import Link from "next/link";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import type { SiteStatus } from "@/services/sites/types";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<SiteStatus, string> = {
  connected: "bg-green-100 text-green-800",
  degraded: "bg-yellow-100 text-yellow-800",
  reconnect_needed: "bg-red-100 text-red-800",
  disabled: "bg-slate-200 text-slate-600",
};

export default async function DashboardPage() {
  const repo = supabaseSitesRepo(createServiceSupabase());
  const sites = await listSites({ repo, mcp: createSiteMcpClient });

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">Sites</h1>
      {sites.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-white p-12 text-center text-slate-500">
          No sites connected yet.{" "}
          <Link href="/sites/new" className="text-slate-900 underline">Connect your first site</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((s) => (
            <Link key={s.id} href={`/sites/${s.id}`}
              className="rounded-lg border bg-white p-4 shadow-sm transition hover:shadow">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-medium">{s.name}</h2>
                  <p className="text-sm text-slate-500">{s.url.replace(/^https?:\/\//, "")}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[s.status]}`}>
                  {s.status.replace("_", " ")}
                </span>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                {s.capabilities.abilities.length} abilities
                {s.client_label ? ` · ${s.client_label}` : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Implement the test-connection action and overview page**

`src/app/(dashboard)/sites/[id]/actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { testSiteConnection } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

export async function runConnectionTest(siteId: string) {
  const user = await requireUser();
  const repo = supabaseSitesRepo(createServiceSupabase());
  const result = await testSiteConnection({ repo, mcp: createSiteMcpClient }, siteId, user.id);
  revalidatePath(`/sites/${siteId}`);
  return result;
}
```

`src/app/(dashboard)/sites/[id]/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { getSite } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { runConnectionTest } from "./actions";

export const dynamic = "force-dynamic";

const TABS = ["Overview", "Plugins", "Themes", "Security", "SEO", "GeoGrid", "Reports"] as const;

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repo = supabaseSitesRepo(createServiceSupabase());
  const site = await getSite({ repo, mcp: createSiteMcpClient }, id);
  if (!site) notFound();

  const db = createServiceSupabase();
  const { data: activity } = await db
    .from("activity_log")
    .select("action,detail,at")
    .eq("site_id", id)
    .order("at", { ascending: false })
    .limit(10);

  const testAction = runConnectionTest.bind(null, id);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{site.name}</h1>
        <form action={testAction}>
          <button className="rounded border px-3 py-1.5 text-sm hover:bg-slate-100">
            Test connection
          </button>
        </form>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        <a href={site.url} target="_blank" className="underline">{site.url}</a>
        {" · "}status: {site.status.replace("_", " ")}
      </p>

      <nav className="mb-6 flex gap-1 border-b">
        {TABS.map((t, i) => (
          <span key={t}
            className={`px-3 py-2 text-sm ${i === 0
              ? "border-b-2 border-slate-900 font-medium"
              : "cursor-not-allowed text-slate-400"}`}
            title={i === 0 ? undefined : "Coming in a later phase"}>
            {t}
          </span>
        ))}
      </nav>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-medium">Connection</h2>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">MCP endpoint</dt>
              <dd className="truncate pl-4">{site.mcp_endpoint}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">WP user</dt>
              <dd>{site.wp_username}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Abilities</dt>
              <dd>{site.capabilities.abilities.length}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Connected</dt>
              <dd>{new Date(site.created_at).toLocaleDateString()}</dd></div>
          </dl>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-slate-500">All abilities</summary>
            <ul className="mt-2 max-h-48 overflow-y-auto text-xs text-slate-600">
              {site.capabilities.abilities.map((a) => <li key={a}>{a}</li>)}
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
                  <span>{a.action}</span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {new Date(a.at).toLocaleString()}
                  </span>
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

- [ ] **Step 4: Full verification**

Run: `npm test` → all green. Run: `npm run build` → clean build.
Then `npm run dev` and walk the loop end-to-end: login → `/dashboard` (grid or empty state) → connect a real site → land on `/sites/[id]` → abilities listed, activity shows `site.connect` → "Test connection" → activity gains `site.test_connection`, status badge correct. Sign out → any page redirects to `/login`.

- [ ] **Step 5: Commit**

```powershell
git add "src/app/(dashboard)"; git commit -m "feat: dashboard site grid and site overview with connection test"
```

---

### Task 9: README + deploy notes

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything above. Produces: onboarding doc for the team.

- [ ] **Step 1: Write README**

`README.md`:
```markdown
# WP Control Panel

Internal OCS dashboard for managing client WordPress sites via their Novamira
MCP endpoints. Spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md`.

## Setup

1. `npm install`
2. Copy `.env.example` → `.env.local` and fill in:
   - Supabase project URL + anon key + service-role key (Project Settings → API)
   - `APP_ENCRYPTION_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
3. Apply `supabase/migrations/0001_init.sql` (`npx supabase db push`, or SQL editor).
4. In Supabase Auth settings: disable public signups; invite team members by email.
5. `npm run dev` → http://localhost:3000

## Connecting a site

The site needs the Novamira plugin active. Create an Application Password for
an admin user (WP Admin → Users → Profile → Application Passwords), then use
"+ Connect site". Credentials are encrypted at rest; all WordPress calls run
server-side over MCP.

## Commands

- `npm run dev` / `npm run build` / `npm start`
- `npm test` — Vitest suite

## Deploy (Vercel)

Set the same env vars in Vercel. `vercel.json` crons and pg_cron schedules
arrive in Phase 2 with the job system.
```

- [ ] **Step 2: Commit**

```powershell
git add README.md; git commit -m "docs: setup and onboarding README"
```

---

## Self-Review Notes

- **Spec coverage (Phase 1 scope):** scaffold (T1), schema+RLS+invite-only auth (T2, T5), encrypted credentials (T3, T6), MCP client layer + capability discovery + typed errors (T4, T6), add-site flow (T6, T7), dashboard grid + overview + activity log + test connection (T8), docs (T9). Later-phase spec items (jobs, crons, scans, marketplace, geogrid, reports) intentionally not here — tables exist, features come in Phases 2–7.
- **Type consistency:** `SiteMcpClient`/`McpFactory` used identically in Tasks 4, 6, 7, 8; `SitesRepo` shape in Task 6 matches its test's in-memory impl; status enum matches the SQL enum in Task 2.
- **Known judgment calls:** full schema in one migration (avoids per-phase migration churn); `parseToolResult` assumes Novamira returns JSON text blocks (verified against live discover-abilities output during design); disabled tab placeholders on the site page are intentional scaffolding for Phases 2–7.
