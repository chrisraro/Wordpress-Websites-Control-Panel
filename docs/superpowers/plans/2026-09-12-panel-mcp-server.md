# Panel MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the WP Control Panel over the Model Context Protocol at `/api/mcp`, so an LLM client acting as a specific user can read every site's state and take the same actions the UI offers, through the existing service layer and its permission model.

**Architecture:** A stateless Streamable HTTP route authenticates a per-user bearer token, builds the *same* `Viewer` the cookie session path builds, and registers tools that call `src/services/*` — never a repo, never Supabase directly. Destructive tools are dry-run by default and require `confirm: true` plus a `reason`, which lands in `activity_log`. Slow work is enqueued onto the existing jobs queue rather than run in-request.

**Tech Stack:** Next.js 15.5.24 App Router, `@modelcontextprotocol/sdk` 1.30.0, zod 4.4.3, Supabase Postgres, vitest 4.1.11.

**Source spec:** `docs/superpowers/specs/2026-09-12-panel-mcp-server-design.md` (Approved). Read it once before Task 1; every task below cites the section it implements.

## Global Constraints

- Token secret format: `wpcp_` + base64url of 32 random bytes. Stored only as `token_hash` = sha256 hex of the **whole secret including the `wpcp_` prefix**. Shown once, never recoverable.
- `token_prefix` is the **first 8 characters of the secret**, for display only.
- Migration number is exactly `0021_api_tokens.sql`. `0020` is the highest existing migration.
- Every tool calls a function in `src/services/*` with `ctx.auth.viewer` or `ctx.auth.viewer.id`. No tool file may contain `Repo(`, `.from("`, `createServiceSupabase`, or `ctx.db`.
- Every result that names a site includes `environment: "production" | "staging"`, and every tool description states that sites carry an environment and that staging and production must not be confused.
- Destructive tools accept `confirm?: boolean` (default `false`) and `reason?: string` (required when `confirm` is true; 10–500 chars).
- `confirm` absent/false → preview only, no service call, `isError: false`. `confirm: true` without `reason` → `isError: true`. Read-only token with `confirm: true` → `isError: true` naming the **token** as read-only, distinct from a permission denial.
- Audit row per enqueue and per executed destructive action: `action: "mcp.<tool_name>"`, `detail: { token_id, reason, args }` with every key matching `/password|secret|token|key/i` replaced by `"[redacted]"`. Reads are **not** logged.
- A site the viewer cannot reach is reported as **not found**, never as forbidden — the existence of a client's site is itself information.
- Excluded by decision: user, role and permission management tools. OAuth, rate limiting, per-token site scoping, MCP resources and prompts are out of scope.
- Tests live in `tests/*.test.ts` (flat, no subdirectories). Run with `npm test`. The `@` alias resolves to `src`.
- Any test importing a module that transitively imports `src/lib/authz/server.ts` must call `vi.mock("server-only", () => ({}))` first — there is no real `server-only` package installed.

---

### Task 1: Prove the SDK/zod contract, and pin it in one module

**Why this is first:** every tool will declare argument schemas the same way. `@modelcontextprotocol/sdk` 1.30.0 converts zod schemas to JSON Schema, and this project is on **zod 4.4.3** while that tooling historically targeted zod 3. If the pairing does not work, discovering it on the last tool means rewriting every tool file. This task proves it with a real in-process MCP round trip and puts the answer behind one import.

**Files:**
- Create: `src/mcp/schema.ts`
- Create: `tests/mcp-schema.test.ts`
- Modify: `package.json` (add a `version` field — Step 4)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export { z }` — every later task imports `z` from `@/mcp/schema`, never from `zod` directly
  - `export const MCP_SERVER_NAME = "wp-control-panel"`
  - `export const MCP_SERVER_VERSION: string`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "@/mcp/schema";

describe("the SDK accepts this project's zod and round-trips a tool", () => {
  it("lists a tool with a usable input schema and calls it", async () => {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

    server.registerTool(
      "echo_site",
      {
        description:
          "Test tool. Sites carry an environment; never confuse staging with production.",
        inputSchema: {
          site_id: z.string().uuid().describe("The site's id"),
          times: z.number().int().min(1).max(3).default(1),
        },
      },
      async ({ site_id, times }) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ site_id, times }) }],
      }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === "echo_site");
    expect(tool).toBeDefined();
    // The schema must survive conversion with its properties intact -- an empty
    // or absent properties object is the exact failure mode of a zod/SDK
    // version mismatch, and it fails silently at runtime rather than at build.
    expect(tool!.inputSchema.type).toBe("object");
    expect(Object.keys((tool!.inputSchema as { properties: object }).properties))
      .toEqual(expect.arrayContaining(["site_id", "times"]));

    const result = await client.callTool({
      name: "echo_site",
      arguments: { site_id: "11111111-1111-1111-1111-111111111111", times: 2 },
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toEqual({
      site_id: "11111111-1111-1111-1111-111111111111",
      times: 2,
    });

    await client.close();
    await server.close();
  });

  it("rejects arguments that violate the schema", async () => {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    server.registerTool(
      "needs_uuid",
      { description: "Test tool.", inputSchema: { site_id: z.string().uuid() } },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({
      name: "needs_uuid",
      arguments: { site_id: "not-a-uuid" },
    });
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it("exposes a non-placeholder server version", () => {
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-schema.test.ts`
Expected: FAIL — `Cannot find module '@/mcp/schema'`.

- [ ] **Step 3: Create `src/mcp/schema.ts`, choosing the zod entry point the SDK accepts**

Write this version **first**:

```ts
/**
 * The single place the MCP layer gets its schema builder and server identity.
 *
 * Why `z` is re-exported here rather than imported from "zod" in each tool
 * file: the SDK converts these schemas to JSON Schema for tools/list, and that
 * conversion is version-sensitive. This project is on zod 4; if the SDK's
 * converter cannot read zod 4 schemas it produces an EMPTY properties object
 * and every tool silently accepts anything. Pinning the import to one module
 * means switching entry points is a one-line change here rather than an edit
 * to every tool file. tests/mcp-schema.test.ts asserts the converted schema
 * keeps its properties.
 */
export { z } from "zod";

export const MCP_SERVER_NAME = "wp-control-panel";

/**
 * Read from package.json so the version an MCP client sees is the deployed
 * app's version, per the spec's "version from package.json".
 */
import pkg from "../../package.json" with { type: "json" };
export const MCP_SERVER_VERSION: string = pkg.version;
```

Run the test. **If the first test fails on the `properties` assertion** (empty or missing properties), change only the first export line to zod 4's built-in v3 compatibility namespace, which exists for exactly this situation:

```ts
export { z } from "zod/v3";
```

Re-run. Then replace the speculative wording in that comment with which entry point actually won and why. Do not start Task 2 until both schema tests pass — every later task depends on this answer.

If `import ... with { type: "json" }` is rejected by the transform, replace those two lines with:

```ts
import { createRequire } from "node:module";
const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
export const MCP_SERVER_VERSION: string = pkg.version;
```

- [ ] **Step 4: Add the `version` field to `package.json`**

`package.json` currently has **no `version` key**, so `pkg.version` is `undefined` and the third test fails. Add it as the second line, after `"name": "wp-control-panel"`:

```json
  "version": "0.1.0",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/mcp-schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json src/mcp/schema.ts tests/mcp-schema.test.ts
git commit -m "feat(mcp): pin the SDK schema entry point and server identity"
```

---

### Task 2: Extract `loadViewer` from `getViewer`

**Why:** the token path and the session path must produce identical `Viewer`s. The only way to guarantee that is for both to call the same function. This is a pure refactor — no behaviour change — and it must keep every fail-closed branch exactly as it is (spec §Identity).

**Files:**
- Modify: `src/lib/authz/server.ts:14-77`
- Modify: `tests/authz-server.test.ts` (add a describe block; leave existing tests untouched)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `export async function loadViewer(userId: string, email: string | null): Promise<Viewer | null>`
  - `getViewer` keeps its exact existing signature `() => Promise<Viewer | null>`, still wrapped in `cache()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/authz-server.test.ts`, inside the existing file so it reuses the `state` / `fakeQuery` / table-routing harness already there. Add `loadViewer` to the existing import from `@/lib/authz/server`:

```ts
describe("loadViewer is the one place a Viewer is built", () => {
  it("builds the same Viewer as getViewer does for the same user", async () => {
    state.user = { id: "u1", email: "u@example.com" };
    const viaSession = await getViewer();
    const viaToken = await loadViewer("u1", "u@example.com");

    expect(viaToken).not.toBeNull();
    expect(viaSession).not.toBeNull();
    // Sets and Maps do not compare usefully with toEqual, so compare contents.
    expect(viaToken!.id).toBe(viaSession!.id);
    expect(viaToken!.email).toBe(viaSession!.email);
    expect(viaToken!.role).toBe(viaSession!.role);
    expect([...viaToken!.permissions].sort()).toEqual([...viaSession!.permissions].sort());
    expect([...viaToken!.grants.entries()].sort()).toEqual(
      [...viaSession!.grants.entries()].sort(),
    );
  });

  it("returns null when the user has no role row", async () => {
    // Arrange an empty user_roles result the way this file's existing
    // "no role" test already does, then assert loadViewer agrees.
    const v = await loadViewer("no-role-user", null);
    expect(v).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/authz-server.test.ts`
Expected: FAIL — `loadViewer` is not exported.

- [ ] **Step 3: Perform the extraction**

In `src/lib/authz/server.ts`, replace lines 14-77 with these two declarations. Every comment and every `return null` branch moves verbatim into `loadViewer`; nothing is added or removed.

```ts
/**
 * Builds a Viewer from a user id. The single source of truth for "what may
 * this person do", shared by the cookie-session path (getViewer) and the API
 * token path (src/lib/authz/token.ts) so the two cannot diverge.
 * tests/authz-server.test.ts and tests/mcp-identity.test.ts pin that.
 */
export async function loadViewer(
  userId: string,
  email: string | null,
): Promise<Viewer | null> {
  const db = createServiceSupabase();
  const [roleRow, overrides, grants] = await Promise.all([
    db.from("user_roles").select("role").eq("user_id", userId).maybeSingle(),
    db.from("user_permission_overrides").select("permission,effect").eq("user_id", userId),
    db.from("user_site_access").select("site_id,access_level").eq("user_id", userId),
  ]);

  // A database error is not "no data" — Supabase returns data:[] for a
  // successful query with zero rows, and data:null (with .error set) when
  // the query itself failed. Conflating the two would fail OPEN for the
  // overrides query in particular: a `deny` override exists to strip a
  // permission the role would otherwise grant, so if that query errors and
  // we treated it as "no overrides", the role default would silently win
  // and the user would keep a permission that was explicitly revoked. A
  // database error means we do not know what this user may do, and the
  // only safe answer to that is nothing — so any of the four queries
  // erroring denies the viewer entirely.
  if (roleRow.error) {
    console.error("[authz] failed to load viewer:", "user_roles", roleRow.error.message);
    return null;
  }
  if (overrides.error) {
    console.error("[authz] failed to load viewer:", "user_permission_overrides", overrides.error.message);
    return null;
  }
  if (grants.error) {
    console.error("[authz] failed to load viewer:", "user_site_access", grants.error.message);
    return null;
  }

  // No role row means no access at all — fail closed. This is why the
  // bootstrap script must run before enforcement ships.
  const roleValue = roleRow.data?.role;
  const role = APP_ROLES.find((r) => r === roleValue);
  if (!role) return null;

  const rolePerms = await db
    .from("role_permissions").select("permission").eq("role", role);
  if (rolePerms.error) {
    console.error("[authz] failed to load viewer:", "role_permissions", rolePerms.error.message);
    return null;
  }

  const permissions = new Set<AppPermission>(
    (rolePerms.data ?? []).map((r) => r.permission as AppPermission),
  );
  for (const o of overrides.data ?? []) {
    if (o.effect === "allow") permissions.add(o.permission as AppPermission);
    else permissions.delete(o.permission as AppPermission);
  }

  return {
    id: userId,
    email,
    role,
    permissions,
    grants: new Map((grants.data ?? []).map((g) => [g.site_id, g.access_level as SiteAccessLevel])),
  };
}

/**
 * Role, permissions and grants are read per request rather than carried in the
 * JWT, so removing someone's access takes effect on their next request instead
 * of whenever their token happens to refresh. cache() keeps that to one round
 * of queries per render.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const auth = await createServerSupabase();
  const { data } = await auth.auth.getUser();
  if (!data.user) return null;
  return loadViewer(data.user.id, data.user.email ?? null);
});
```

- [ ] **Step 4: Run the authz suites to verify nothing regressed**

Run: `npm test -- tests/authz-server.test.ts tests/authz-read-path.test.ts tests/authz-pages.test.ts tests/authz-actions-toolkit.test.ts`
Expected: PASS, including every pre-existing test. A failure here means the extraction changed behaviour — fix the extraction, do not adjust the old tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/authz/server.ts tests/authz-server.test.ts
git commit -m "refactor(authz): extract loadViewer so token and session paths share it"
```

---

### Task 3: Migration `0021_api_tokens.sql`, plus the tokens repo and service

**Files:**
- Create: `supabase/migrations/0021_api_tokens.sql`
- Create: `src/services/tokens/types.ts`
- Create: `src/services/tokens/repo.ts`
- Create: `src/services/tokens/service.ts`
- Create: `tests/mcp-tokens.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces:

```ts
// types.ts
export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  read_only: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
export interface ApiTokenAuthRow {
  id: string; user_id: string; read_only: boolean;
  expires_at: string | null; revoked_at: string | null;
}
export type TokenExpiry = "none" | "30d" | "90d" | "1y";

// repo.ts
export interface TokensRepo {
  insert(row: {
    user_id: string; name: string; token_hash: string; token_prefix: string;
    read_only: boolean; expires_at: string | null;
  }): Promise<{ id: string }>;
  findByHash(tokenHash: string): Promise<ApiTokenAuthRow | null>;
  listForUser(userId: string): Promise<ApiTokenRow[]>;
  getOwner(tokenId: string): Promise<{ user_id: string } | null>;
  revoke(tokenId: string): Promise<void>;
  stampUsed(tokenId: string, atIso: string): Promise<void>;
}
export function supabaseTokensRepo(db: SupabaseClient): TokensRepo;

// service.ts
export function hashToken(secret: string): string;            // sha256 hex
export function generateSecret(): string;                      // "wpcp_" + 43 base64url chars
export function tokenPrefix(secret: string): string;           // first 8 chars
export function expiryToIso(e: TokenExpiry, now: Date): string | null;
export async function mintToken(
  repo: TokensRepo,
  input: { userId: string; name: string; readOnly: boolean; expiry: TokenExpiry },
): Promise<{ id: string; secret: string }>;
export async function listTokens(repo: TokensRepo, userId: string): Promise<ApiTokenRow[]>;
export async function revokeToken(repo: TokensRepo, tokenId: string): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  hashToken, generateSecret, tokenPrefix, expiryToIso, mintToken,
} from "@/services/tokens/service";
import type { TokensRepo } from "@/services/tokens/repo";
import type { ApiTokenAuthRow, ApiTokenRow } from "@/services/tokens/types";

function fakeRepo() {
  const rows: (ApiTokenRow & { token_hash: string })[] = [];
  const repo: TokensRepo & { rows: typeof rows } = {
    rows,
    async insert(r) {
      const id = `tok-${rows.length + 1}`;
      rows.push({
        id, user_id: r.user_id, name: r.name, token_prefix: r.token_prefix,
        read_only: r.read_only, expires_at: r.expires_at, last_used_at: null,
        revoked_at: null, created_at: new Date().toISOString(), token_hash: r.token_hash,
      });
      return { id };
    },
    async findByHash(h) {
      const r = rows.find((x) => x.token_hash === h);
      return r ? ({ id: r.id, user_id: r.user_id, read_only: r.read_only,
        expires_at: r.expires_at, revoked_at: r.revoked_at } as ApiTokenAuthRow) : null;
    },
    async listForUser(u) { return rows.filter((r) => r.user_id === u); },
    async getOwner(id) {
      const r = rows.find((x) => x.id === id);
      return r ? { user_id: r.user_id } : null;
    },
    async revoke(id) {
      const r = rows.find((x) => x.id === id);
      if (r) r.revoked_at = new Date().toISOString();
    },
    async stampUsed(id, at) {
      const r = rows.find((x) => x.id === id);
      if (r) r.last_used_at = at;
    },
  };
  return repo;
}

describe("token secrets", () => {
  it("generates a wpcp_ secret of 32 random bytes in base64url", () => {
    const s = generateSecret();
    expect(s.startsWith("wpcp_")).toBe(true);
    // 32 bytes base64url with no padding is 43 characters.
    expect(s.slice(5)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(s);
  });

  it("hashes the WHOLE secret including the wpcp_ prefix", () => {
    const s = "wpcp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    expect(hashToken(s)).toBe(createHash("sha256").update(s).digest("hex"));
    // The hash must never be the secret, or the database would hold a usable key.
    expect(hashToken(s)).not.toBe(s);
    expect(hashToken(s)).toHaveLength(64);
  });

  it("takes the prefix from the first 8 characters", () => {
    expect(tokenPrefix("wpcp_XYZabc123")).toBe("wpcp_XYZ");
    expect(tokenPrefix("wpcp_XYZabc123")).toHaveLength(8);
  });
});

describe("expiry", () => {
  const now = new Date("2026-09-12T00:00:00.000Z");
  it("maps each choice to an absolute instant, or null for none", () => {
    expect(expiryToIso("none", now)).toBeNull();
    expect(expiryToIso("30d", now)).toBe("2026-10-12T00:00:00.000Z");
    expect(expiryToIso("90d", now)).toBe("2026-12-11T00:00:00.000Z");
    expect(expiryToIso("1y", now)).toBe("2027-09-12T00:00:00.000Z");
  });
});

describe("mintToken", () => {
  it("stores the hash and prefix, and returns the secret exactly once", async () => {
    const repo = fakeRepo();
    const { id, secret } = await mintToken(repo, {
      userId: "u1", name: "Claude Code", readOnly: false, expiry: "30d",
    });
    expect(id).toBe("tok-1");
    const stored = repo.rows[0];
    expect(stored.token_hash).toBe(hashToken(secret));
    expect(stored.token_prefix).toBe(secret.slice(0, 8));
    expect(stored.read_only).toBe(false);
    expect(stored.expires_at).not.toBeNull();
    // The secret itself must appear nowhere in the stored row.
    expect(JSON.stringify(stored)).not.toContain(secret);
    // And it must be findable by its hash, which is how authentication works.
    expect(await repo.findByHash(hashToken(secret))).not.toBeNull();
  });

  it("records read_only tokens as read_only", async () => {
    const repo = fakeRepo();
    await mintToken(repo, { userId: "u1", name: "n8n", readOnly: true, expiry: "none" });
    expect(repo.rows[0].read_only).toBe(true);
    expect(repo.rows[0].expires_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-tokens.test.ts`
Expected: FAIL — cannot resolve `@/services/tokens/service`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0021_api_tokens.sql`:

```sql
-- Per-user API tokens for the MCP server at /api/mcp.
--
-- A token carries no scope of its own beyond `read_only`: authentication
-- resolves it to a user id, and that user's role, permission overrides and
-- site grants are then loaded exactly as they are for a cookie session, so an
-- LLM can never exceed the person who minted the token.
--
-- token_hash is sha256 of the whole secret, not an encryption of it. The panel
-- never needs the secret back, so nothing that can read this table can produce
-- a usable token. (Site application passwords are encrypted rather than hashed
-- because they must be recovered in order to be used; tokens have no such need.)
create table api_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,
  token_prefix  text not null,
  read_only     boolean not null default false,
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index api_tokens_user_id_idx on api_tokens (user_id);

-- Authentication looks a token up by hash on every single MCP request.
create index api_tokens_token_hash_idx on api_tokens (token_hash);

-- Service-role only, like the other credential-adjacent tables: RLS is enabled
-- with no policies, so anon and authenticated clients can reach nothing here.
-- The panel reads and writes this table exclusively through
-- createServiceSupabase() after its own authz checks.
alter table api_tokens enable row level security;
```

- [ ] **Step 4: Write `types.ts`, `repo.ts` and `service.ts`**

`src/services/tokens/types.ts` — exactly the three type declarations from the **Produces** block above.

`src/services/tokens/repo.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiTokenAuthRow, ApiTokenRow } from "./types";

export interface TokensRepo {
  insert(row: {
    user_id: string; name: string; token_hash: string; token_prefix: string;
    read_only: boolean; expires_at: string | null;
  }): Promise<{ id: string }>;
  findByHash(tokenHash: string): Promise<ApiTokenAuthRow | null>;
  listForUser(userId: string): Promise<ApiTokenRow[]>;
  getOwner(tokenId: string): Promise<{ user_id: string } | null>;
  revoke(tokenId: string): Promise<void>;
  stampUsed(tokenId: string, atIso: string): Promise<void>;
}

const LIST_COLS =
  "id,user_id,name,token_prefix,read_only,expires_at,last_used_at,revoked_at,created_at";

export function supabaseTokensRepo(db: SupabaseClient): TokensRepo {
  return {
    async insert(row) {
      const { data, error } = await db
        .from("api_tokens").insert(row).select("id").single();
      if (error) throw new Error(error.message);
      return { id: data.id as string };
    },
    async findByHash(tokenHash) {
      const { data, error } = await db
        .from("api_tokens")
        .select("id,user_id,read_only,expires_at,revoked_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as ApiTokenAuthRow | null) ?? null;
    },
    async listForUser(userId) {
      const { data, error } = await db
        .from("api_tokens").select(LIST_COLS)
        .eq("user_id", userId).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as ApiTokenRow[];
    },
    async getOwner(tokenId) {
      const { data, error } = await db
        .from("api_tokens").select("user_id").eq("id", tokenId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { user_id: string } | null) ?? null;
    },
    async revoke(tokenId) {
      const { error } = await db
        .from("api_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", tokenId);
      if (error) throw new Error(error.message);
    },
    async stampUsed(tokenId, atIso) {
      const { error } = await db
        .from("api_tokens").update({ last_used_at: atIso }).eq("id", tokenId);
      if (error) throw new Error(error.message);
    },
  };
}
```

`src/services/tokens/service.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import type { TokensRepo } from "./repo";
import type { ApiTokenRow, TokenExpiry } from "./types";

const SECRET_PREFIX = "wpcp_";
/** Display prefix length, per the spec: the first 8 characters of the secret. */
const PREFIX_LEN = 8;

/** sha256 of the whole secret, including the wpcp_ prefix. Hex. */
export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64url");
}

export function tokenPrefix(secret: string): string {
  return secret.slice(0, PREFIX_LEN);
}

export function expiryToIso(e: TokenExpiry, now: Date): string | null {
  if (e === "none") return null;
  const d = new Date(now.getTime());
  if (e === "30d") d.setUTCDate(d.getUTCDate() + 30);
  else if (e === "90d") d.setUTCDate(d.getUTCDate() + 90);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString();
}

/**
 * Mints a token and returns the secret. This is the only moment the secret
 * exists in a readable form: only its sha256 is persisted, so it cannot be
 * shown again.
 */
export async function mintToken(
  repo: TokensRepo,
  input: { userId: string; name: string; readOnly: boolean; expiry: TokenExpiry },
): Promise<{ id: string; secret: string }> {
  const secret = generateSecret();
  const { id } = await repo.insert({
    user_id: input.userId,
    name: input.name,
    token_hash: hashToken(secret),
    token_prefix: tokenPrefix(secret),
    read_only: input.readOnly,
    expires_at: expiryToIso(input.expiry, new Date()),
  });
  return { id, secret };
}

export async function listTokens(repo: TokensRepo, userId: string): Promise<ApiTokenRow[]> {
  return repo.listForUser(userId);
}

export async function revokeToken(repo: TokensRepo, tokenId: string): Promise<void> {
  await repo.revoke(tokenId);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/mcp-tokens.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Apply the migration and confirm the table**

Apply `0021_api_tokens.sql` the same way the preceding migrations were applied (the operator runs it against Supabase). Afterwards confirm: `api_tokens` exists, `token_hash` is unique, and RLS is enabled with zero policies.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0021_api_tokens.sql src/services/tokens tests/mcp-tokens.test.ts
git commit -m "feat(tokens): api_tokens table with hashed per-user API tokens"
```

---

### Task 4: `authenticateToken` and `applyReadOnly`

**Files:**
- Create: `src/lib/authz/token.ts`
- Create: `tests/mcp-identity.test.ts`

**Interfaces:**
- Consumes: `loadViewer(userId, email)` (Task 2); `TokensRepo`, `hashToken` (Task 3).
- Produces:

```ts
export interface TokenAuth { viewer: Viewer; tokenId: string; readOnly: boolean }
export function applyReadOnly(viewer: Viewer): Viewer;
export async function authenticateToken(
  secret: string,
  repo: TokensRepo,
  load?: (userId: string, email: string | null) => Promise<Viewer | null>,
  now?: Date,
): Promise<TokenAuth | null>;
```

`load` is injectable so tests need not mock the Supabase module graph; it defaults to `loadViewer`.

**Note on the read-only rule.** `APP_PERMISSIONS` is currently `sites.view_all`, `sites.manage`, `wp_toolkit.manage`, `security.run`, `seo.run`, `geogrid.manage`, `reports.generate`, `reports.manage`, `queue.process`, `users.manage`. Stripping every permission ending in `.manage`, `.run`, `.generate` or `.process` therefore leaves **exactly `sites.view_all`**. The test asserts that literal outcome.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-identity.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { applyReadOnly, authenticateToken } from "@/lib/authz/token";
import { hashToken } from "@/services/tokens/service";
import { APP_PERMISSIONS, type AppPermission } from "@/lib/authz/types";
import type { Viewer } from "@/lib/authz/decide";
import type { TokensRepo } from "@/services/tokens/repo";
import type { ApiTokenAuthRow } from "@/services/tokens/types";

function adminViewer(): Viewer {
  return {
    id: "u1",
    email: "a@example.com",
    role: "admin",
    permissions: new Set<AppPermission>([...APP_PERMISSIONS]),
    grants: new Map([["site-a", "manage"], ["site-b", "read"]]),
  };
}

function repoWith(row: ApiTokenAuthRow | null, stamped: string[] = []): TokensRepo {
  return {
    async insert() { throw new Error("not used"); },
    async findByHash() { return row; },
    async listForUser() { return []; },
    async getOwner() { return null; },
    async revoke() {},
    async stampUsed(id) { stamped.push(id); },
  };
}

describe("applyReadOnly", () => {
  it("strips every write permission and leaves exactly the read ones", () => {
    const ro = applyReadOnly(adminViewer());
    // With the current APP_PERMISSIONS, sites.view_all is the only permission
    // that is not a write, so it is the only one that may survive.
    expect([...ro.permissions]).toEqual(["sites.view_all"]);
  });

  it("downgrades every site grant to read", () => {
    const ro = applyReadOnly(adminViewer());
    expect([...ro.grants.entries()].sort()).toEqual([
      ["site-a", "read"], ["site-b", "read"],
    ]);
  });

  it("does not mutate the viewer it was given", () => {
    const v = adminViewer();
    applyReadOnly(v);
    expect(v.permissions.has("sites.manage")).toBe(true);
    expect(v.grants.get("site-a")).toBe("manage");
  });

  it("keeps identity fields", () => {
    const ro = applyReadOnly(adminViewer());
    expect(ro.id).toBe("u1");
    expect(ro.email).toBe("a@example.com");
    expect(ro.role).toBe("admin");
  });
});

describe("authenticateToken", () => {
  const secret = "wpcp_testsecrettestsecrettestsecrettestsecre";
  const base: ApiTokenAuthRow = {
    id: "tok-1", user_id: "u1", read_only: false, expires_at: null, revoked_at: null,
  };
  const load = async () => adminViewer();

  it("resolves a valid token to a Viewer and stamps last_used_at", async () => {
    const stamped: string[] = [];
    const auth = await authenticateToken(secret, repoWith(base, stamped), load);
    expect(auth).not.toBeNull();
    expect(auth!.tokenId).toBe("tok-1");
    expect(auth!.readOnly).toBe(false);
    expect(auth!.viewer.permissions.has("sites.manage")).toBe(true);
    expect(stamped).toEqual(["tok-1"]);
  });

  it("looks the token up by its hash, never by the secret", async () => {
    let seen = "";
    const repo = { ...repoWith(base), async findByHash(h: string) { seen = h; return base; } };
    await authenticateToken(secret, repo as TokensRepo, load);
    expect(seen).toBe(hashToken(secret));
    expect(seen).not.toBe(secret);
  });

  it("rejects a revoked token", async () => {
    const row = { ...base, revoked_at: "2026-09-01T00:00:00.000Z" };
    expect(await authenticateToken(secret, repoWith(row), load)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const row = { ...base, expires_at: "2026-09-01T00:00:00.000Z" };
    const now = new Date("2026-09-12T00:00:00.000Z");
    expect(await authenticateToken(secret, repoWith(row), load, now)).toBeNull();
  });

  it("accepts a token whose expiry is still in the future", async () => {
    const row = { ...base, expires_at: "2026-10-01T00:00:00.000Z" };
    const now = new Date("2026-09-12T00:00:00.000Z");
    expect(await authenticateToken(secret, repoWith(row), load, now)).not.toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(await authenticateToken(secret, repoWith(null), load)).toBeNull();
  });

  it("rejects a token whose user has no role", async () => {
    const auth = await authenticateToken(secret, repoWith(base), async () => null);
    expect(auth).toBeNull();
  });

  it("applies read_only to the viewer when the token is read-only", async () => {
    const auth = await authenticateToken(secret, repoWith({ ...base, read_only: true }), load);
    expect(auth!.readOnly).toBe(true);
    expect([...auth!.viewer.permissions]).toEqual(["sites.view_all"]);
    expect([...auth!.viewer.grants.values()]).toEqual(["read", "read"]);
  });

  it("still authenticates when stamping last_used_at fails", async () => {
    const repo = {
      ...repoWith(base),
      async stampUsed() { throw new Error("db down"); },
    };
    const auth = await authenticateToken(secret, repo as TokensRepo, load);
    expect(auth).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-identity.test.ts`
Expected: FAIL — cannot resolve `@/lib/authz/token`.

- [ ] **Step 3: Write `src/lib/authz/token.ts`**

```ts
import { loadViewer } from "./server";
import { type AppPermission } from "./types";
import type { Viewer } from "./decide";
import { hashToken } from "@/services/tokens/service";
import type { TokensRepo } from "@/services/tokens/repo";

export interface TokenAuth {
  viewer: Viewer;
  tokenId: string;
  readOnly: boolean;
}

/**
 * Permission suffixes that denote a write. Anything ending in one of these is
 * removed from a read-only token's viewer. Expressed as suffixes rather than a
 * hardcoded list so a permission added to APP_PERMISSIONS later is read-only
 * by default -- the safe direction. tests/mcp-identity.test.ts asserts the
 * resulting set against the current vocabulary, so a new permission that ought
 * to be stripped but is not matched here fails the suite loudly.
 */
const WRITE_SUFFIXES = [".manage", ".run", ".generate", ".process"] as const;

function isWrite(p: AppPermission): boolean {
  return WRITE_SUFFIXES.some((s) => p.endsWith(s));
}

/** Pure. Returns a new Viewer; never mutates the one passed in. */
export function applyReadOnly(viewer: Viewer): Viewer {
  const permissions = new Set<AppPermission>();
  for (const p of viewer.permissions) if (!isWrite(p)) permissions.add(p);
  const grants = new Map<string, "read" | "manage">();
  for (const siteId of viewer.grants.keys()) grants.set(siteId, "read");
  return { id: viewer.id, email: viewer.email, role: viewer.role, permissions, grants };
}

/**
 * Resolves a bearer secret to the viewer who minted it.
 *
 * Returns null for every failure -- unknown, revoked, expired, or a user who no
 * longer has a role -- because the caller's only correct response to any of
 * them is the same 401, and distinguishing them would tell a caller whether a
 * given secret was ever real.
 */
export async function authenticateToken(
  secret: string,
  repo: TokensRepo,
  load: (userId: string, email: string | null) => Promise<Viewer | null> = loadViewer,
  now: Date = new Date(),
): Promise<TokenAuth | null> {
  const row = await repo.findByHash(hashToken(secret));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return null;

  // Email is not stored on the token row; the viewer's identity fields come
  // from loadViewer, the same function the session path uses.
  const base = await load(row.user_id, null);
  if (!base) return null;

  // Fire-and-forget: a token that works must not stop working because a
  // bookkeeping write failed.
  try {
    await repo.stampUsed(row.id, now.toISOString());
  } catch (e) {
    console.error("[authz] failed to stamp api_token.last_used_at:", e);
  }

  return {
    viewer: row.read_only ? applyReadOnly(base) : base,
    tokenId: row.id,
    readOnly: row.read_only,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/mcp-identity.test.ts tests/mcp-tokens.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/authz/token.ts tests/mcp-identity.test.ts
git commit -m "feat(authz): authenticate API tokens into the same Viewer as sessions"
```

---

### Task 5: The confirm / preview / audit helpers

**Why before the tools:** every destructive and enqueue tool shares this behaviour. Writing it once, tested, is what keeps the tool implementations honest.

**Files:**
- Create: `src/mcp/confirm.ts`
- Create: `tests/mcp-confirm.test.ts`

**Interfaces:**
- Consumes: `z` from `@/mcp/schema` (Task 1); `TokenAuth` from `@/lib/authz/token` (Task 4); `can` from `@/lib/authz/decide`; `AppPermission` from `@/lib/authz/types`.
- Produces:

```ts
export const ENVIRONMENT_NOTE: string;
export const CONFIRM_SHAPE: { confirm: ZodType; reason: ZodType };
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export function ok(payload: unknown): ToolResult;
export function fail(message: string): ToolResult;
export function preview(summary: string, details: unknown): ToolResult;
export function redactArgs(args: Record<string, unknown>): Record<string, unknown>;
export function requirePermission(auth: TokenAuth, p: AppPermission): ToolResult | null;
export function requireWritableToken(auth: TokenAuth): ToolResult | null;
export type ConfirmGate =
  | { proceed: true; reason: string }
  | { proceed: false; result: ToolResult };
export function gateConfirm(
  auth: TokenAuth,
  args: { confirm?: boolean; reason?: string },
  previewSummary: string,
  previewDetails: unknown,
): ConfirmGate;
```

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-confirm.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import {
  gateConfirm, redactArgs, ok, fail, preview, ENVIRONMENT_NOTE,
  requirePermission, requireWritableToken,
} from "@/mcp/confirm";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";

function auth(opts: { readOnly?: boolean; permissions?: AppPermission[] } = {}): TokenAuth {
  return {
    viewer: {
      id: "u1", email: null, role: "admin",
      permissions: new Set(opts.permissions ?? []), grants: new Map(),
    } as Viewer,
    tokenId: opts.readOnly ? "tok-2" : "tok-1",
    readOnly: Boolean(opts.readOnly),
  };
}

const REASON = "Applying the September security patch";

describe("gateConfirm", () => {
  it("returns a preview and does not proceed when confirm is absent", () => {
    const g = gateConfirm(auth(), {}, "Would update 3 plugins", { count: 3 });
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBeFalsy();
    expect(g.result.content[0].text).toContain("Would update 3 plugins");
  });

  it("returns a preview when confirm is explicitly false", () => {
    expect(gateConfirm(auth(), { confirm: false }, "Would do it", {}).proceed).toBe(false);
  });

  it("errors when confirm is true but no reason is given", () => {
    const g = gateConfirm(auth(), { confirm: true }, "s", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBe(true);
    expect(g.result.content[0].text).toMatch(/reason is required/i);
  });

  it("errors when the reason is shorter than 10 characters", () => {
    const g = gateConfirm(auth(), { confirm: true, reason: "too short" }, "s", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBe(true);
  });

  it("proceeds with a valid confirm and reason", () => {
    const g = gateConfirm(auth(), { confirm: true, reason: REASON }, "s", {});
    expect(g.proceed).toBe(true);
    if (!g.proceed) throw new Error("unreachable");
    expect(g.reason).toBe(REASON);
  });

  it("blames the TOKEN, not a permission, when the token is read-only", () => {
    const g = gateConfirm(auth({ readOnly: true }), { confirm: true, reason: REASON }, "s", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBe(true);
    const text = g.result.content[0].text;
    expect(text).toMatch(/read-only/i);
    expect(text).toMatch(/token/i);
    // A read-only refusal must not be mistaken for a permission problem: the
    // fixes differ (mint a new token vs. be granted a permission).
    expect(text).not.toMatch(/permission/i);
  });

  it("previews rather than erroring for a read-only token that did not confirm", () => {
    const g = gateConfirm(auth({ readOnly: true }), {}, "Would update 3 plugins", {});
    expect(g.proceed).toBe(false);
    if (g.proceed) throw new Error("unreachable");
    expect(g.result.isError).toBeFalsy();
  });
});

describe("requirePermission", () => {
  it("passes when the viewer holds it", () => {
    expect(requirePermission(auth({ permissions: ["wp_toolkit.manage"] }), "wp_toolkit.manage"))
      .toBeNull();
  });

  it("names the missing permission when it does not", () => {
    const r = requirePermission(auth(), "wp_toolkit.manage");
    expect(r?.isError).toBe(true);
    expect(r?.content[0].text).toContain("wp_toolkit.manage");
  });
});

describe("requireWritableToken", () => {
  it("passes a normal token", () => {
    expect(requireWritableToken(auth())).toBeNull();
  });

  it("refuses a read-only token without mentioning permissions", () => {
    const r = requireWritableToken(auth({ readOnly: true }));
    expect(r?.isError).toBe(true);
    expect(r?.content[0].text).toMatch(/read-only/i);
    expect(r?.content[0].text).not.toMatch(/permission/i);
  });
});

describe("redactArgs", () => {
  it("redacts anything that looks like a credential, case-insensitively", () => {
    expect(redactArgs({
      site_id: "s1", app_password: "hunter2", API_KEY: "k", authToken: "t",
      clientSecret: "cs", plugin: "akismet/akismet.php",
    })).toEqual({
      site_id: "s1", app_password: "[redacted]", API_KEY: "[redacted]",
      authToken: "[redacted]", clientSecret: "[redacted]",
      plugin: "akismet/akismet.php",
    });
  });

  it("leaves ordinary values alone", () => {
    expect(redactArgs({ confirm: true, reason: "why" }))
      .toEqual({ confirm: true, reason: "why" });
  });
});

describe("result shapes", () => {
  it("ok serialises the payload as JSON text", () => {
    const r = ok({ a: 1 });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ a: 1 });
  });

  it("fail marks isError", () => {
    expect(fail("nope")).toEqual({
      content: [{ type: "text", text: "nope" }], isError: true,
    });
  });

  it("preview carries the summary, the details and how to confirm", () => {
    const r = preview("Would act on 2 sites", { sites: ["a", "b"] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Would act on 2 sites");
    expect(r.content[0].text).toContain("\"sites\"");
    expect(r.content[0].text).toMatch(/confirm/i);
  });

  it("publishes an environment note for tool descriptions", () => {
    expect(ENVIRONMENT_NOTE).toMatch(/staging/i);
    expect(ENVIRONMENT_NOTE).toMatch(/production/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-confirm.test.ts`
Expected: FAIL — cannot resolve `@/mcp/confirm`.

- [ ] **Step 3: Write `src/mcp/confirm.ts`**

```ts
import { z } from "./schema";
import { can } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";
import type { TokenAuth } from "@/lib/authz/token";

/**
 * Appended to every tool description. An LLM that cannot tell a client's
 * staging site from their production one is the most expensive mistake this
 * server can make, so the warning is not left to per-tool prose.
 */
export const ENVIRONMENT_NOTE =
  "Every site carries an environment, either production or staging. " +
  "Results always include it. Never assume, and never act on production " +
  "when the user meant staging.";

const REASON_MIN = 10;
const REASON_MAX = 500;

/** Spread into a destructive tool's inputSchema. */
export const CONFIRM_SHAPE = {
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Must be true to actually perform this action. When false or omitted, " +
      "returns a preview of what would happen and changes nothing.",
    ),
  reason: z
    .string()
    .min(REASON_MIN)
    .max(REASON_MAX)
    .optional()
    .describe(
      `Why this action is being taken, ${REASON_MIN}-${REASON_MAX} characters. ` +
      "Required when confirm is true. Recorded in the audit log.",
    ),
};

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function preview(summary: string, details: unknown): ToolResult {
  return {
    content: [{
      type: "text",
      text:
        `DRY RUN — nothing has been changed.\n\n${summary}\n\n` +
        `${JSON.stringify(details, null, 2)}\n\n` +
        "To perform this, call again with confirm: true and a reason.",
    }],
  };
}

const SECRETISH = /password|secret|token|key/i;

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SECRETISH.test(k) ? "[redacted]" : v;
  }
  return out;
}

/**
 * A missing permission NAMES the permission: the fix is to be granted it, and
 * the user cannot work that out from a generic refusal.
 */
export function requirePermission(auth: TokenAuth, p: AppPermission): ToolResult | null {
  if (can(auth.viewer, p)) return null;
  return fail(`You do not hold the ${p} permission, which this action requires.`);
}

export function requireWritableToken(auth: TokenAuth): ToolResult | null {
  if (!auth.readOnly) return null;
  return fail(
    "This API token is read-only, so it cannot perform write actions. " +
    "Mint a token without the read-only flag to do this.",
  );
}

export type ConfirmGate =
  | { proceed: true; reason: string }
  | { proceed: false; result: ToolResult };

/**
 * The single decision point for every destructive tool.
 *
 * Order matters: a caller who did not ask to change anything gets a preview
 * even on a read-only token, because previewing is a read. The read-only
 * refusal is reserved for someone who actually tried to write, and it names
 * the token rather than a permission -- the two have different fixes, and
 * conflating them sends the user to the wrong place.
 */
export function gateConfirm(
  auth: TokenAuth,
  args: { confirm?: boolean; reason?: string },
  previewSummary: string,
  previewDetails: unknown,
): ConfirmGate {
  if (!args.confirm) {
    return { proceed: false, result: preview(previewSummary, previewDetails) };
  }
  const tokenDenied = requireWritableToken(auth);
  if (tokenDenied) return { proceed: false, result: tokenDenied };

  const reason = (args.reason ?? "").trim();
  if (reason.length < REASON_MIN) {
    return {
      proceed: false,
      result: fail(
        "A reason is required when confirm is true, and must be at least " +
        `${REASON_MIN} characters. It is recorded in the audit log.`,
      ),
    };
  }
  if (reason.length > REASON_MAX) {
    return { proceed: false, result: fail(`The reason must be at most ${REASON_MAX} characters.`) };
  }
  return { proceed: true, reason };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/mcp-confirm.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/confirm.ts tests/mcp-confirm.test.ts
git commit -m "feat(mcp): dry-run-by-default confirm gate and audit redaction"
```

---

### Task 6: Tool context, server assembly, and the `sites` group

**Files:**
- Create: `src/mcp/context.ts`
- Create: `src/mcp/server.ts`
- Create: `src/mcp/tools/sites.ts`
- Create: `tests/mcp-tools-sites.test.ts`

**Interfaces:**
- Consumes: `MCP_SERVER_NAME`, `MCP_SERVER_VERSION`, `z` (Task 1); `TokenAuth` (Task 4); `ok`, `fail`, `ENVIRONMENT_NOTE` (Task 5). Existing code, with these exact signatures:
  - `listSitesForViewer(deps: SitesDeps, viewer: Viewer): Promise<SiteRow[]>`
  - `getSite(deps: SitesDeps, id: string): Promise<SiteRow | null>`
  - `testSiteConnection(deps: SitesDeps, id: string, actorId: string): Promise<{ ok: boolean; status: SiteStatus; error?: string }>`
  - `SitesDeps = { repo: SitesRepo; mcp: McpFactory; discover?: ...; jobs: JobsRepo }`
  - `ManageDeps = { sites: SitesRepo; jobs: JobsRepo; mcp: McpFactory }`
  - `friendlySiteError(raw: unknown): string` from `@/lib/mcp/errors`
  - `canAccessSite(viewer, siteId, min)` from `@/lib/authz/decide`
  - `supabaseSitesRepo(db)`, `supabaseJobsRepo(db)`, `createSiteMcpClient`, `createServiceSupabase`
- Produces:

```ts
// context.ts
export interface ToolCtx {
  auth: TokenAuth;
  sites: SitesDeps;
  manage: ManageDeps;
  jobs: JobsRepo;
  audit(action: string, siteId: string | null, detail: Record<string, unknown>): Promise<void>;
}
export function buildToolCtx(auth: TokenAuth): ToolCtx;

// server.ts
export function buildServer(ctx: ToolCtx): McpServer;

// tools/sites.ts
export function register(server: McpServer, ctx: ToolCtx): void;
export function siteSummary(site: SiteRow): {
  id: string; name: string; url: string; environment: string;
  status: string; client_label: string | null;
};
```

`ToolCtx` deliberately has **no `db` field**: Task 11's source scan forbids a tool reaching one, and offering it invites the mistake.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-tools-sites.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { register, siteSummary } from "@/mcp/tools/sites";
import type { ToolCtx } from "@/mcp/context";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";

const SITE_A = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Alpha",
  url: "https://alpha.test", environment: "production", status: "connected",
  client_label: "Alpha Co",
};
const SITE_B = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Beta",
  url: "https://beta.test", environment: "staging", status: "connected",
  client_label: null,
};

function viewerWith(perms: AppPermission[], grants: [string, "read" | "manage"][]): Viewer {
  return {
    id: "u1", email: "u@example.com", role: "admin",
    permissions: new Set(perms), grants: new Map(grants),
  };
}

/**
 * A ctx whose repo is a fake and whose audit calls are recorded, so a test can
 * assert that reads write no audit rows.
 */
export function ctxWith(viewer: Viewer, opts: { readOnly?: boolean } = {}) {
  const audited: { action: string; siteId: string | null }[] = [];
  const all = [SITE_A, SITE_B];
  const auth: TokenAuth = {
    viewer, tokenId: "tok-1", readOnly: Boolean(opts.readOnly),
  };
  return {
    auth,
    audited,
    sites: {
      repo: {
        listSites: async () => all,
        getSite: async (id: string) => all.find((s) => s.id === id) ?? null,
        getSiteCredentials: async () => null,
      },
    },
    async audit(action: string, siteId: string | null) { audited.push({ action, siteId }); },
  } as unknown as ToolCtx & { audited: { action: string; siteId: string | null }[] };
}

async function connect(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  register(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const payload = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0].text);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("siteSummary", () => {
  it("always includes the environment", () => {
    expect(siteSummary(SITE_A as never).environment).toBe("production");
    expect(siteSummary(SITE_B as never).environment).toBe("staging");
  });
});

describe("list_sites", () => {
  it("returns every site for a viewer with sites.view_all, each with its environment", async () => {
    const { client, close } = await connect(ctxWith(viewerWith(["sites.view_all"], [])));
    const out = payload(await client.callTool({ name: "list_sites", arguments: {} }));
    expect(out.sites.map((s: { name: string }) => s.name)).toEqual(["Alpha", "Beta"]);
    expect(out.sites.every((s: { environment?: string }) => Boolean(s.environment))).toBe(true);
    await close();
  });

  it("returns only granted sites for a viewer without sites.view_all", async () => {
    const { client, close } = await connect(ctxWith(viewerWith([], [[SITE_B.id, "read"]])));
    const out = payload(await client.callTool({ name: "list_sites", arguments: {} }));
    expect(out.sites.map((s: { name: string }) => s.name)).toEqual(["Beta"]);
    await close();
  });

  it("filters by environment when asked", async () => {
    const { client, close } = await connect(ctxWith(viewerWith(["sites.view_all"], [])));
    const out = payload(await client.callTool({
      name: "list_sites", arguments: { environment: "staging" },
    }));
    expect(out.sites.map((s: { name: string }) => s.name)).toEqual(["Beta"]);
    await close();
  });

  it("logs nothing -- reads are not audited", async () => {
    const ctx = ctxWith(viewerWith(["sites.view_all"], []));
    const { client, close } = await connect(ctx);
    await client.callTool({ name: "list_sites", arguments: {} });
    expect(ctx.audited).toEqual([]);
    await close();
  });
});

describe("get_site", () => {
  it("returns the site when the viewer may see it", async () => {
    const { client, close } = await connect(ctxWith(viewerWith(["sites.view_all"], [])));
    const out = payload(await client.callTool({
      name: "get_site", arguments: { site_id: SITE_A.id },
    }));
    expect(out.site.name).toBe("Alpha");
    expect(out.site.environment).toBe("production");
    await close();
  });

  it("says NOT FOUND rather than forbidden for a site the viewer cannot see", async () => {
    const { client, close } = await connect(ctxWith(viewerWith([], [[SITE_B.id, "read"]])));
    const res = await client.callTool({ name: "get_site", arguments: { site_id: SITE_A.id } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    // The existence of a site is itself information: never reveal that the
    // site is real but off-limits.
    expect(textOf(res)).not.toMatch(/permission|forbidden|denied/i);
    await close();
  });
});

describe("tool descriptions", () => {
  it("every registered tool warns about environments", async () => {
    const { client, close } = await connect(ctxWith(viewerWith(["sites.view_all"], [])));
    const { tools } = await client.listTools();
    expect(tools.length).toBe(3);
    for (const t of tools) expect(t.description, t.name).toMatch(/staging/i);
    await close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-tools-sites.test.ts`
Expected: FAIL — cannot resolve `@/mcp/tools/sites`.

- [ ] **Step 3: Write `src/mcp/context.ts`**

```ts
import { createServiceSupabase } from "@/lib/supabase/server";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo, type JobsRepo } from "@/services/jobs/repo";
import type { SitesDeps } from "@/services/sites/service";
import type { ManageDeps } from "@/services/manage/service";
import type { TokenAuth } from "@/lib/authz/token";

export interface ToolCtx {
  auth: TokenAuth;
  sites: SitesDeps;
  manage: ManageDeps;
  jobs: JobsRepo;
  /**
   * One activity_log row. Writes and enqueues only -- reads are never audited,
   * because activity_log records changes and logging reads would bury them.
   */
  audit(action: string, siteId: string | null, detail: Record<string, unknown>): Promise<void>;
}

/**
 * Builds the real dependency set for one request, mirroring what the server
 * actions under src/app/(dashboard) construct, so a tool and the equivalent
 * button run identical code below the service boundary.
 *
 * There is deliberately no `db` on ToolCtx: a tool that queries directly would
 * bypass the authorization and audit behaviour every service function carries,
 * and tests/mcp-tools-structure.test.ts scans for exactly that.
 */
export function buildToolCtx(auth: TokenAuth): ToolCtx {
  const db = createServiceSupabase();
  const sitesRepo = supabaseSitesRepo(db);
  const jobs = supabaseJobsRepo(db);
  return {
    auth,
    jobs,
    sites: { repo: sitesRepo, mcp: createSiteMcpClient, jobs },
    manage: { sites: sitesRepo, jobs, mcp: createSiteMcpClient },
    async audit(action, siteId, detail) {
      await sitesRepo.insertActivity({
        actor: auth.viewer.id,
        site_id: siteId,
        action,
        detail: { token_id: auth.tokenId, ...detail },
      });
    },
  };
}
```

- [ ] **Step 4: Write `src/mcp/tools/sites.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE } from "../confirm";
import type { ToolCtx } from "../context";
import { listSitesForViewer, getSite, testSiteConnection } from "@/services/sites/service";
import { friendlySiteError } from "@/lib/mcp/errors";
import { canAccessSite } from "@/lib/authz/decide";
import type { SiteRow } from "@/services/sites/types";

/** The site shape every tool returns. `environment` is never omitted. */
export function siteSummary(site: SiteRow) {
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    environment: site.environment,
    status: site.status,
    client_label: site.client_label ?? null,
  };
}

/**
 * A site the viewer cannot reach is reported as not found, never as forbidden:
 * the existence of a client's site is itself information.
 */
export const NOT_FOUND = "Site not found.";

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "list_sites",
    {
      description:
        `List every WordPress site you can see, with its environment and status. ${ENVIRONMENT_NOTE}`,
      inputSchema: {
        environment: z
          .enum(["production", "staging"])
          .optional()
          .describe("Return only sites in this environment."),
      },
    },
    async ({ environment }) => {
      try {
        const all = await listSitesForViewer(ctx.sites, ctx.auth.viewer);
        const filtered = environment ? all.filter((s) => s.environment === environment) : all;
        return ok({ count: filtered.length, sites: filtered.map(siteSummary) });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "get_site",
    {
      description: `Get one site's details. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async ({ site_id }) => {
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        const site = await getSite(ctx.sites, site_id);
        if (!site) return fail(NOT_FOUND);
        return ok({ site: siteSummary(site) });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  server.registerTool(
    "test_site_connection",
    {
      description:
        "Check that the panel can still reach a site over MCP and report its status. " +
        `This is a read: it changes nothing on the site. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async ({ site_id }) => {
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        return ok(await testSiteConnection(ctx.sites, site_id, ctx.auth.viewer.id));
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
```

- [ ] **Step 5: Write `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./schema";
import type { ToolCtx } from "./context";
import * as sites from "./tools/sites";

const GROUPS = [sites];

/**
 * Builds a server whose tools are bound to one request's authenticated
 * context. A new instance per request is required, not merely tidy: the
 * transport runs in stateless mode because consecutive requests may land on
 * different Vercel instances, so nothing may be shared between them.
 */
export function buildServer(ctx: ToolCtx): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  for (const g of GROUPS) g.register(server, ctx);
  return server;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- tests/mcp-tools-sites.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/context.ts src/mcp/server.ts src/mcp/tools/sites.ts tests/mcp-tools-sites.test.ts
git commit -m "feat(mcp): tool context, server assembly and the sites tool group"
```

---

### Task 7: The `/api/mcp` route

**Files:**
- Create: `src/app/api/mcp/route.ts`
- Create: `tests/mcp-route.test.ts`

**Interfaces:**
- Consumes: `authenticateToken` (Task 4); `supabaseTokensRepo` (Task 3); `buildToolCtx`, `buildServer` (Task 6); `MCP_SERVER_NAME` (Task 1).
- Produces: `POST`, `GET`, `DELETE` handlers, plus `export const dynamic = "force-dynamic"` and `export const maxDuration = 60`.

Implements spec §Transport (test pin 7).

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  auth: null as unknown,
  authenticateCalls: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createServiceSupabase: () => ({}),
  createServerSupabase: async () => ({}),
  requireUser: async () => ({ id: "u1" }),
}));
vi.mock("@/services/tokens/repo", () => ({ supabaseTokensRepo: () => ({}) }));
vi.mock("@/lib/authz/token", () => ({
  authenticateToken: async (secret: string) => {
    state.authenticateCalls.push(secret);
    return state.auth;
  },
}));
vi.mock("@/mcp/context", () => ({ buildToolCtx: () => ({}) }));

import { GET, DELETE, POST } from "@/app/api/mcp/route";

beforeEach(() => {
  state.auth = null;
  state.authenticateCalls = [];
});

function post(headers: Record<string, string> = {}) {
  return new Request("https://panel.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("POST /api/mcp authentication", () => {
  it("401s with a WWW-Authenticate challenge when the header is missing", async () => {
    const res = await POST(post());
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="wp-control-panel"');
  });

  it("401s when the Authorization header is not a Bearer token", async () => {
    const res = await POST(post({ authorization: "Basic dXNlcjpwYXNz" }));
    expect(res.status).toBe(401);
    expect(state.authenticateCalls).toEqual([]);
  });

  it("401s when the token does not authenticate", async () => {
    state.auth = null;
    const res = await POST(post({ authorization: "Bearer wpcp_nope" }));
    expect(res.status).toBe(401);
    expect(state.authenticateCalls).toEqual(["wpcp_nope"]);
  });

  it("passes only the secret, without the Bearer prefix or whitespace", async () => {
    await POST(post({ authorization: "Bearer   wpcp_spaced  " }));
    expect(state.authenticateCalls).toEqual(["wpcp_spaced"]);
  });

  it("does not echo the rejected secret back to the caller", async () => {
    const res = await POST(post({ authorization: "Bearer wpcp_supersecret" }));
    expect(await res.text()).not.toContain("wpcp_supersecret");
  });
});

describe("methods with no meaning in stateless mode", () => {
  it("405s on GET", async () => {
    expect((await GET()).status).toBe(405);
  });

  it("405s on DELETE", async () => {
    expect((await DELETE()).status).toBe(405);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/mcp/route`.

- [ ] **Step 3: Write `src/app/api/mcp/route.ts`**

```ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseTokensRepo } from "@/services/tokens/repo";
import { authenticateToken } from "@/lib/authz/token";
import { buildToolCtx } from "@/mcp/context";
import { buildServer } from "@/mcp/server";
import { MCP_SERVER_NAME } from "@/mcp/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHALLENGE = { "WWW-Authenticate": `Bearer realm="${MCP_SERVER_NAME}"` };

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: a valid API token is required." },
      id: null,
    }),
    { status: 401, headers: { "content-type": "application/json", ...CHALLENGE } },
  );
}

function bearer(req: Request): string | null {
  const raw = req.headers.get("authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

export async function POST(req: Request): Promise<Response> {
  const secret = bearer(req);
  if (!secret) return unauthorized();

  const repo = supabaseTokensRepo(createServiceSupabase());
  const auth = await authenticateToken(secret, repo);
  // Every failure mode -- unknown, revoked, expired, no role -- is one 401.
  // Distinguishing them would tell a caller whether a secret was ever real.
  if (!auth) return unauthorized();

  const server = buildServer(buildToolCtx(auth));
  // Stateless is required, not preferred: consecutive requests may land on
  // different Vercel instances and there is no shared session store, so every
  // request must carry its own auth and be complete in itself.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}

const NOT_ALLOWED = { status: 405, headers: { allow: "POST" } };

/** Stateless mode has no server-initiated stream to open. */
export async function GET(): Promise<Response> {
  return new Response("Method Not Allowed", NOT_ALLOWED);
}

/** Stateless mode has no session to end. */
export async function DELETE(): Promise<Response> {
  return new Response("Method Not Allowed", NOT_ALLOWED);
}
```

- [ ] **Step 4: Verify the transport's request signature before relying on it**

`StreamableHTTPServerTransport.handleRequest` in SDK 1.30 may expect Node's `IncomingMessage`/`ServerResponse` rather than a web `Request`. Check the installed type:

Run: `grep -n "handleRequest" node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts`

If the signature is Node-shaped, keep the auth block and the `finally` cleanup exactly as written and change only the three transport lines: use the SDK's Fetch-API transport if one is exported, otherwise bridge explicitly (read `await req.text()`, hand it to the transport, return its response body). Record what the installed SDK required in a comment so the next reader does not rediscover it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/mcp-route.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Verify against the running server**

With `npm run dev` and a token minted via a scratch script calling `mintToken`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# expect: 401

curl -s -X POST http://localhost:3000/api/mcp \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# expect: a JSON-RPC result listing list_sites, get_site, test_site_connection
```

A 406 means the `accept` header is missing — Streamable HTTP requires both media types.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/mcp/route.ts tests/mcp-route.test.ts
git commit -m "feat(mcp): stateless Streamable HTTP route with bearer token auth"
```

---

### Task 8: Read tool groups — inventory, security, seo, geogrid, reports, jobs

**Files:**
- Create: `src/mcp/tools/inventory.ts`, `security.ts`, `seo.ts`, `geogrid.ts`, `reports.ts`, `jobs.ts`
- Modify: `src/mcp/context.ts` (add the repo accessors these groups need)
- Modify: `src/mcp/server.ts` (add the six groups to `GROUPS`)
- Create: `tests/mcp-tools-reads.test.ts`

**Interfaces:**
- Consumes: `ToolCtx`, `ok`, `fail`, `ENVIRONMENT_NOTE`, `siteSummary`, `NOT_FOUND`, `canAccessSite`, `friendlySiteError`.
- Produces: `register(server, ctx)` from each of the six modules.

**The eight read tools this task delivers.** Before writing each, open the service or repo it reads and use the real signature — do not invent one. The five `run_*` / `refresh_*` / `generate_*` tools enqueue and belong to Task 9.

| Tool | Argument schema | Reads |
|---|---|---|
| `get_inventory` | `site_id: uuid` | latest snapshot: core version, plugins, themes, maintenance, gsc |
| `get_security` | `site_id: uuid` | latest grade, open vulnerabilities, latest checks |
| `get_seo` | `site_id: uuid` | latest `seo_snapshots` row per source |
| `get_geogrid` | `site_id: uuid` | latest geogrid run plus its config |
| `list_reports` | `site_id: uuid` optional | reports repo, scoped to visible sites |
| `get_report_link` | `report_id: uuid` | existing share-link resolution |
| `list_jobs` | `site_id: uuid` optional, `status` enum optional, `limit: int 1-100 default 20` | jobs repo, scoped to visible sites |
| `get_batch` | `batch_id: uuid` | the same data `src/app/api/batches/[id]/route.ts` returns |

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-tools-reads.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolCtx } from "@/mcp/context";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";

const SITE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SITE = {
  id: SITE_ID, name: "Alpha", url: "https://alpha.test",
  environment: "production", status: "connected", client_label: null,
};

const SITE_TOOLS = ["get_inventory", "get_security", "get_seo", "get_geogrid"] as const;
const ALL_READ_TOOLS = [
  ...SITE_TOOLS, "list_reports", "get_report_link", "list_jobs", "get_batch",
] as const;

/**
 * Builds a ctx with fakes for every repo the read groups touch, recording
 * audit calls so the "reads are not logged" assertion is real.
 */
function ctxFor(opts: {
  permissions?: AppPermission[]; grants?: [string, "read" | "manage"][];
} = {}) {
  const audited: { action: string }[] = [];
  const viewer: Viewer = {
    id: "u1", email: null, role: "admin",
    permissions: new Set(opts.permissions ?? []),
    grants: new Map(opts.grants ?? []),
  };
  const auth: TokenAuth = { viewer, tokenId: "tok-1", readOnly: false };
  return {
    auth,
    audited,
    sites: {
      repo: {
        listSites: async () => [SITE],
        getSite: async (id: string) => (id === SITE_ID ? SITE : null),
      },
    },
    inventory: { latestSnapshot: async () => ({ core: { version: "6.8" }, plugins: [], themes: [] }) },
    security: {
      latestGrade: async () => ({ grade: "A", score: 96 }),
      openVulns: async () => [],
      latestChecks: async () => [],
    },
    seo: { latestPerSource: async () => ({}) },
    geogrid: { latestRun: async () => null, config: async () => null },
    reports: { list: async () => [], get: async () => null, shareLink: async () => null },
    jobsRead: { list: async () => [], batch: async () => null },
    async audit(action: string) { audited.push({ action }); },
  } as unknown as ToolCtx & { audited: { action: string }[] };
}

async function connectAll(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  for (const name of ["inventory", "security", "seo", "geogrid", "reports", "jobs"]) {
    const mod = await import(`@/mcp/tools/${name}`);
    mod.register(server, ctx);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("read tools", () => {
  it("registers all eight", async () => {
    const { client, close } = await connectAll(ctxFor({ permissions: ["sites.view_all"] }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ALL_READ_TOOLS) expect(names, t).toContain(t);
    await close();
  });

  it("every description warns about environments", async () => {
    const { client, close } = await connectAll(ctxFor({ permissions: ["sites.view_all"] }));
    for (const t of (await client.listTools()).tools) {
      expect(t.description, t.name).toMatch(/staging/i);
    }
    await close();
  });

  it.each(SITE_TOOLS)("%s reports not found for a site the viewer cannot see", async (name) => {
    const { client, close } = await connectAll(ctxFor({ permissions: [], grants: [] }));
    const res = await client.callTool({ name, arguments: { site_id: SITE_ID } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    expect(textOf(res)).not.toMatch(/permission|forbidden/i);
    await close();
  });

  it.each(SITE_TOOLS)("%s includes the site's environment in its result", async (name) => {
    const ctx = ctxFor({ permissions: ["sites.view_all"], grants: [[SITE_ID, "read"]] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name, arguments: { site_id: SITE_ID } });
    expect(JSON.parse(textOf(res)).site.environment).toBe("production");
    await close();
  });

  it("no read tool writes an audit row", async () => {
    const ctx = ctxFor({ permissions: ["sites.view_all"], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    for (const name of SITE_TOOLS) {
      await client.callTool({ name, arguments: { site_id: SITE_ID } });
    }
    await client.callTool({ name: "list_jobs", arguments: {} });
    await client.callTool({ name: "list_reports", arguments: {} });
    expect(ctx.audited).toEqual([]);
    await close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-tools-reads.test.ts`
Expected: FAIL — the six tool modules do not exist.

- [ ] **Step 3: Write the six modules**

Each follows `src/mcp/tools/sites.ts` exactly: import `z` from `../schema`; `ok`/`fail`/`ENVIRONMENT_NOTE` from `../confirm`; `siteSummary`/`NOT_FOUND` from `./sites`; guard with `canAccessSite(ctx.auth.viewer, site_id, "read")`; call the service or repo accessor; wrap throws in `friendlySiteError(e)`; include `site: siteSummary(site)` in every payload naming a site.

Worked example — `src/mcp/tools/inventory.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import { ok, fail, ENVIRONMENT_NOTE } from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite } from "@/services/sites/service";
import { friendlySiteError } from "@/lib/mcp/errors";
import { canAccessSite } from "@/lib/authz/decide";

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "get_inventory",
    {
      description:
        "Get a site's latest inventory snapshot: WordPress core version, plugins " +
        "and themes with their versions and whether an update is available, " +
        `maintenance mode, and Google Search Console verification state. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async ({ site_id }) => {
      if (!canAccessSite(ctx.auth.viewer, site_id, "read")) return fail(NOT_FOUND);
      try {
        const site = await getSite(ctx.sites, site_id);
        if (!site) return fail(NOT_FOUND);
        const snapshot = await ctx.inventory.latestSnapshot(site_id);
        return ok({
          site: siteSummary(site),
          snapshot: snapshot ?? null,
          note: snapshot
            ? undefined
            : "No inventory has been collected yet. Use refresh_inventory to collect it.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
}
```

Add the accessors (`inventory`, `security`, `seo`, `geogrid`, `reports`, `jobsRead`) to `ToolCtx` in `src/mcp/context.ts` and construct each in `buildToolCtx` from the existing repo factory the corresponding page already uses. Do not add a `db` field.

- [ ] **Step 4: Register the six groups**

In `src/mcp/server.ts`, import each module and extend the array:

```ts
import * as sites from "./tools/sites";
import * as inventory from "./tools/inventory";
import * as security from "./tools/security";
import * as seo from "./tools/seo";
import * as geogrid from "./tools/geogrid";
import * as reports from "./tools/reports";
import * as jobs from "./tools/jobs";

const GROUPS = [sites, inventory, security, seo, geogrid, reports, jobs];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/mcp-tools-reads.test.ts tests/mcp-tools-sites.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp tests/mcp-tools-reads.test.ts
git commit -m "feat(mcp): inventory, security, seo, geogrid, reports and jobs read tools"
```

---

### Task 9: The five enqueue tools, with audit rows

**Files:**
- Modify: `src/mcp/tools/inventory.ts`, `security.ts`, `seo.ts`, `geogrid.ts`, `reports.ts`
- Create: `tests/mcp-audit.test.ts`

**Interfaces:**
- Consumes: `enqueueJob(repo: JobsRepo, type: JobType, siteId: string | null, payload?: Record<string, unknown>, opts?: { dedupe?: boolean }): Promise<{ id: string } | null>` from `@/services/jobs/service`; `ctx.audit`; `requirePermission`, `requireWritableToken`, `redactArgs` (Task 5).
- Produces the five tools below.

| Tool | Permission | `JobType` | Site access |
|---|---|---|---|
| `refresh_inventory` | `sites.manage` | `snapshot_refresh` | `manage` |
| `run_security_scan` | `security.run` | `security_scan` | `read` |
| `run_seo_scan` | `seo.run` | `seo_scan` | `read` |
| `run_geogrid` | `geogrid.manage` | `geogrid_run` | `read` |
| `generate_report` | `reports.generate` | `report_generate` | `read` |

Enqueue tools do **not** take `confirm`: they queue work rather than change a live site. They **are** audited — spec §Audit requires a row for "every enqueue and every destructive action that runs".

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-audit.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolCtx } from "@/mcp/context";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission } from "@/lib/authz/types";

const SITE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SITE = {
  id: SITE_ID, name: "Alpha", url: "https://alpha.test",
  environment: "staging", status: "connected", client_label: null,
};

const ENQUEUE_TOOLS: { name: string; permission: AppPermission; jobType: string }[] = [
  { name: "refresh_inventory", permission: "sites.manage", jobType: "snapshot_refresh" },
  { name: "run_security_scan", permission: "security.run", jobType: "security_scan" },
  { name: "run_seo_scan", permission: "seo.run", jobType: "seo_scan" },
  { name: "run_geogrid", permission: "geogrid.manage", jobType: "geogrid_run" },
  { name: "generate_report", permission: "reports.generate", jobType: "report_generate" },
];

function ctxFor(opts: {
  permissions?: AppPermission[]; grants?: [string, "read" | "manage"][]; readOnly?: boolean;
}) {
  const audited: { action: string; siteId: string | null; detail: Record<string, unknown> }[] = [];
  const enqueued: { type: string; siteId: string | null }[] = [];
  const viewer: Viewer = {
    id: "u1", email: null, role: "admin",
    permissions: new Set(opts.permissions ?? []),
    grants: new Map(opts.grants ?? []),
  };
  const auth: TokenAuth = { viewer, tokenId: "tok-1", readOnly: Boolean(opts.readOnly) };
  return {
    auth, audited, enqueued,
    sites: { repo: { listSites: async () => [SITE], getSite: async () => SITE } },
    inventory: { latestSnapshot: async () => null },
    security: { latestGrade: async () => null, openVulns: async () => [], latestChecks: async () => [] },
    seo: { latestPerSource: async () => ({}) },
    geogrid: { latestRun: async () => null, config: async () => null },
    reports: { list: async () => [], get: async () => null, shareLink: async () => null },
    jobsRead: { list: async () => [], batch: async () => null },
    // enqueueJob is called with ctx.jobs; this fake records what it received.
    jobs: {
      insert: async (r: { type: string; site_id: string | null }) => {
        enqueued.push({ type: r.type, siteId: r.site_id });
        return { id: "job-1" };
      },
      pendingExists: async () => false,
    },
    async audit(action: string, siteId: string | null, detail: Record<string, unknown>) {
      audited.push({ action, siteId, detail });
    },
  } as unknown as ToolCtx & {
    audited: { action: string; siteId: string | null; detail: Record<string, unknown> }[];
    enqueued: { type: string; siteId: string | null }[];
  };
}

async function connectAll(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  for (const name of ["inventory", "security", "seo", "geogrid", "reports", "jobs"]) {
    const mod = await import(`@/mcp/tools/${name}`);
    mod.register(server, ctx);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe.each(ENQUEUE_TOOLS)("$name", (t) => {
  it(`enqueues ${t.jobType} and audits exactly one row`, async () => {
    const ctx = ctxFor({ permissions: [t.permission], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name: t.name, arguments: { site_id: SITE_ID } });

    expect(isError(res)).toBe(false);
    expect(ctx.enqueued).toEqual([{ type: t.jobType, siteId: SITE_ID }]);
    expect(ctx.audited).toHaveLength(1);
    expect(ctx.audited[0].action).toBe(`mcp.${t.name}`);
    expect(ctx.audited[0].siteId).toBe(SITE_ID);
    await close();
  });

  it(`refuses without the ${t.permission} permission, naming it`, async () => {
    const ctx = ctxFor({ permissions: [], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name: t.name, arguments: { site_id: SITE_ID } });

    expect(isError(res)).toBe(true);
    // A missing permission must name the permission: the fix is to be granted
    // it, which the caller cannot deduce from a generic refusal.
    expect(textOf(res)).toContain(t.permission);
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });

  it("refuses on a read-only token, blaming the token", async () => {
    const ctx = ctxFor({
      permissions: [t.permission], grants: [[SITE_ID, "manage"]], readOnly: true,
    });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name: t.name, arguments: { site_id: SITE_ID } });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/read-only/i);
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });
});

describe("audit detail", () => {
  it("carries the token id and never a secret-looking argument value", async () => {
    const ctx = ctxFor({ permissions: ["sites.manage"], grants: [[SITE_ID, "manage"]] });
    const { client, close } = await connectAll(ctx);
    await client.callTool({ name: "refresh_inventory", arguments: { site_id: SITE_ID } });
    const detail = JSON.stringify(ctx.audited[0].detail);
    expect(detail).toContain(SITE_ID);
    expect(detail).not.toMatch(/hunter2|wpcp_/);
    await close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-audit.test.ts`
Expected: FAIL — the enqueue tools are not registered.

- [ ] **Step 3: Add the five enqueue tools**

Worked example, appended inside `register` in `src/mcp/tools/inventory.ts`:

```ts
  server.registerTool(
    "refresh_inventory",
    {
      description:
        "Queue a fresh inventory collection for a site. Returns a job id; the work " +
        "runs on the queue within about a minute, not during this call. Poll " +
        `list_jobs for completion. ${ENVIRONMENT_NOTE}`,
      inputSchema: { site_id: z.string().uuid().describe("The site's id, from list_sites.") },
    },
    async (args) => {
      const { site_id } = args;
      const permDenied = requirePermission(ctx.auth, "sites.manage");
      if (permDenied) return permDenied;
      const tokenDenied = requireWritableToken(ctx.auth);
      if (tokenDenied) return tokenDenied;
      if (!canAccessSite(ctx.auth.viewer, site_id, "manage")) return fail(NOT_FOUND);

      try {
        const job = await enqueueJob(ctx.jobs, "snapshot_refresh", site_id, {}, { dedupe: true });
        await ctx.audit("mcp.refresh_inventory", site_id, { args: redactArgs(args) });
        return ok({
          queued: job !== null,
          job_id: job?.id ?? null,
          note: job === null
            ? "An inventory refresh is already pending for this site; nothing new was queued."
            : "Queued. Poll list_jobs for completion.",
        });
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );
```

Note the order the tests pin: permission → token writability → site access → enqueue → audit. Add the other four in their own group files using the permission, job type and site-access level from the table. For `run_geogrid` and `generate_report`, read the existing UI actions (`src/app/(dashboard)/sites/[id]/geogrid-actions.ts` and the reports actions) and mirror their argument names exactly rather than inventing new ones.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/mcp-audit.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp tests/mcp-audit.test.ts
git commit -m "feat(mcp): enqueue tools for inventory, security, seo, geogrid and reports"
```

---

### Task 10: The destructive tools

**Tool count — resolved 2026-09-12, no need to ask again.** The spec's §Tools table listed twenty-seven rows while its prose said "Twenty-eight tools", and `ManageAction` in `src/services/manage/types.ts` supports three kinds the table omitted but the UI already exposes. The human's decision: **include all three** (`activate_theme`, `delete_theme`, `flush_permalinks`), because leaving them out would let a person do more from the dashboard than an LLM can do through the server. That gives **fifteen destructive tools and thirty-one in total**, which is exactly what the table below specifies. Build it as written. Task 13 corrects the spec's stated count to thirty-one.

**Files:**
- Create: `src/mcp/tools/manage.ts`, `src/mcp/tools/fleet.ts`, `src/mcp/tools/gsc.ts`
- Modify: `src/mcp/tools/jobs.ts` (add `cancel_batch`)
- Modify: `src/mcp/server.ts` (add the three groups)
- Create: `tests/mcp-tools-destructive.test.ts`

**Interfaces:**
- Consumes: `gateConfirm`, `requirePermission`, `redactArgs` (Task 5); `manageSite(deps: ManageDeps, siteId: string, actorId: string, action: ManageAction): Promise<{ ok: boolean; output?: string; error?: string }>`; `enqueueBatch(repo: JobsRepo, type: JobType, siteIds: string[], payload: Record<string, unknown>): Promise<{ batchId: string; count: number }>`; `installVerificationFile` / `removeVerificationFile` from `@/services/gsc/service`.
- Produces: `register(server, ctx)` from each module, and from `src/mcp/tools/manage.ts`:

```ts
export const DESTRUCTIVE_TOOLS: readonly string[];
```

The test enumerates from `DESTRUCTIVE_TOOLS`, so a destructive tool cannot be added without being covered.

| Tool | Permission | Site access | Action built |
|---|---|---|---|
| `update_plugins` | `wp_toolkit.manage` | `manage` | `{kind:"update_all_plugins"}`, or `{kind:"update_plugin", file}` when `plugin_file` is given |
| `update_themes` | `wp_toolkit.manage` | `manage` | `{kind:"update_theme", slug}` per slug |
| `update_core` | `wp_toolkit.manage` | `manage` | `{kind:"update_core"}` |
| `activate_plugin` | `wp_toolkit.manage` | `manage` | `{kind:"activate_plugin", file}` |
| `deactivate_plugin` | `wp_toolkit.manage` | `manage` | `{kind:"deactivate_plugin", file}` |
| `delete_plugin` | `wp_toolkit.manage` | `manage` | `{kind:"delete_plugin", file}` |
| `activate_theme` | `wp_toolkit.manage` | `manage` | `{kind:"activate_theme", slug}` |
| `delete_theme` | `wp_toolkit.manage` | `manage` | `{kind:"delete_theme", slug}` |
| `set_maintenance` | `wp_toolkit.manage` | `manage` | `{kind:"maintenance", enable}` |
| `flush_cache` | `wp_toolkit.manage` | `manage` | `{kind:"flush_cache"}` |
| `flush_permalinks` | `wp_toolkit.manage` | `manage` | `{kind:"flush_permalinks"}` |
| `update_all_plugins_fleet` | `wp_toolkit.manage` | per visible site | `enqueueBatch(ctx.jobs, "update_all_plugins", siteIds, {})` |
| `cancel_batch` | `queue.process` | n/a | existing batch cancel |
| `install_gsc_verification` | `sites.manage` | `manage` | `installVerificationFile` |
| `remove_gsc_verification` | `sites.manage` | `manage` | `removeVerificationFile` |

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-tools-destructive.test.ts`. It carries pins 3 and 4, so it enumerates rather than spot-checks:

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DESTRUCTIVE_TOOLS } from "@/mcp/tools/manage";
import { APP_PERMISSIONS, type AppPermission } from "@/lib/authz/types";
import type { ToolCtx } from "@/mcp/context";
import type { TokenAuth } from "@/lib/authz/token";
import type { Viewer } from "@/lib/authz/decide";

const SITE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BATCH_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const REASON = "Applying the September security patch set";
const SITE = {
  id: SITE_ID, name: "Alpha", url: "https://alpha.test",
  environment: "staging", status: "connected", client_label: null,
};

/** Minimal valid arguments per tool, beyond confirm/reason. */
const ARGS: Record<string, Record<string, unknown>> = {
  update_plugins: { site_id: SITE_ID },
  update_themes: { site_id: SITE_ID, slugs: ["twentytwentyfour"] },
  update_core: { site_id: SITE_ID },
  activate_plugin: { site_id: SITE_ID, plugin_file: "akismet/akismet.php" },
  deactivate_plugin: { site_id: SITE_ID, plugin_file: "akismet/akismet.php" },
  delete_plugin: { site_id: SITE_ID, plugin_file: "akismet/akismet.php" },
  activate_theme: { site_id: SITE_ID, slug: "twentytwentyfour" },
  delete_theme: { site_id: SITE_ID, slug: "twentytwentyfour" },
  set_maintenance: { site_id: SITE_ID, enable: true },
  flush_cache: { site_id: SITE_ID },
  flush_permalinks: { site_id: SITE_ID },
  update_all_plugins_fleet: { environment: "staging" },
  cancel_batch: { batch_id: BATCH_ID },
  install_gsc_verification: { site_id: SITE_ID, verification_token: "google1234.html" },
  remove_gsc_verification: { site_id: SITE_ID },
};

function ctxFor(opts: { readOnly?: boolean; permissions?: AppPermission[] } = {}) {
  const audited: { action: string; detail: Record<string, unknown> }[] = [];
  const serviceCalls: string[] = [];
  const viewer: Viewer = {
    id: "u1", email: null, role: "admin",
    permissions: new Set(opts.permissions ?? [...APP_PERMISSIONS]),
    grants: new Map([[SITE_ID, "manage"]]),
  };
  const auth: TokenAuth = { viewer, tokenId: "tok-1", readOnly: Boolean(opts.readOnly) };
  return {
    auth, audited, serviceCalls,
    sites: { repo: { listSites: async () => [SITE], getSite: async () => SITE } },
    manage: {
      sites: {
        getSite: async () => SITE,
        getSiteCredentials: async () => ({ url: SITE.url }),
        insertActivity: async () => {},
      },
      jobs: {}, mcp: () => { throw new Error("no network in tests"); },
    },
    jobs: {
      insert: async () => { serviceCalls.push("enqueue"); return { id: "job-1" }; },
      pendingExists: async () => false,
    },
    jobsRead: { list: async () => [], batch: async () => ({ id: BATCH_ID }) },
    // Injected seams the tool modules must call instead of importing directly,
    // so a test can assert "no service call happened" on a dry run.
    manageSite: async () => { serviceCalls.push("manageSite"); return { ok: true, output: "Done" }; },
    cancelBatch: async () => { serviceCalls.push("cancelBatch"); return { ok: true }; },
    gsc: {
      install: async () => { serviceCalls.push("gscInstall"); return { ok: true }; },
      remove: async () => { serviceCalls.push("gscRemove"); return { ok: true }; },
    },
    enqueueBatch: async () => { serviceCalls.push("enqueueBatch"); return { batchId: "b1", count: 1 }; },
    async audit(action: string, _siteId: string | null, detail: Record<string, unknown>) {
      audited.push({ action, detail });
    },
  } as unknown as ToolCtx & {
    audited: { action: string; detail: Record<string, unknown> }[];
    serviceCalls: string[];
  };
}

async function connectAll(ctx: ToolCtx) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  for (const name of ["manage", "fleet", "gsc", "jobs"]) {
    const mod = await import(`@/mcp/tools/${name}`);
    mod.register(server, ctx);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("coverage", () => {
  it("ARGS names exactly the declared destructive tools", () => {
    expect(Object.keys(ARGS).sort()).toEqual([...DESTRUCTIVE_TOOLS].sort());
  });
});

describe.each(DESTRUCTIVE_TOOLS)("%s", (name) => {
  it("previews and performs nothing when confirm is omitted", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name, arguments: ARGS[name] });
    expect(isError(res)).toBe(false);
    expect(textOf(res)).toMatch(/dry run/i);
    expect(ctx.serviceCalls).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });

  it("errors when confirm is true but no reason is given", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({ name, arguments: { ...ARGS[name], confirm: true } });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/reason is required/i);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });

  it("performs the action and audits it with confirm and a reason", async () => {
    const ctx = ctxFor();
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name, arguments: { ...ARGS[name], confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(false);
    expect(ctx.serviceCalls.length).toBe(1);
    expect(ctx.audited).toHaveLength(1);
    expect(ctx.audited[0].action).toBe(`mcp.${name}`);
    expect(JSON.stringify(ctx.audited[0].detail)).toContain(REASON);
    await close();
  });

  it("refuses on a read-only token, blaming the token and not a permission", async () => {
    const ctx = ctxFor({ readOnly: true });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name, arguments: { ...ARGS[name], confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/read-only/i);
    expect(textOf(res)).not.toMatch(/permission/i);
    expect(ctx.serviceCalls).toEqual([]);
    expect(ctx.audited).toEqual([]);
    await close();
  });

  it("refuses when the viewer holds no permissions at all", async () => {
    const ctx = ctxFor({ permissions: [] });
    const { client, close } = await connectAll(ctx);
    const res = await client.callTool({
      name, arguments: { ...ARGS[name], confirm: true, reason: REASON },
    });
    expect(isError(res)).toBe(true);
    expect(ctx.serviceCalls).toEqual([]);
    await close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-tools-destructive.test.ts`
Expected: FAIL — cannot resolve `@/mcp/tools/manage`.

- [ ] **Step 3: Write `src/mcp/tools/manage.ts`**

Worked example for one tool. The other ten single-site tools in this file follow it exactly, differing only in name, description, `inputSchema`, preview sentence and the `ManageAction` built.

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "../schema";
import {
  ok, fail, ENVIRONMENT_NOTE, CONFIRM_SHAPE, gateConfirm, redactArgs, requirePermission,
} from "../confirm";
import { siteSummary, NOT_FOUND } from "./sites";
import type { ToolCtx } from "../context";
import { getSite } from "@/services/sites/service";
import { friendlySiteError } from "@/lib/mcp/errors";
import { canAccessSite } from "@/lib/authz/decide";

export const DESTRUCTIVE_TOOLS = [
  "update_plugins", "update_themes", "update_core",
  "activate_plugin", "deactivate_plugin", "delete_plugin",
  "activate_theme", "delete_theme",
  "set_maintenance", "flush_cache", "flush_permalinks",
  "update_all_plugins_fleet", "cancel_batch",
  "install_gsc_verification", "remove_gsc_verification",
] as const;

export function register(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "delete_plugin",
    {
      description:
        "Permanently delete a plugin from a site. Its files are removed; its data " +
        "in the database is not. This cannot be undone from the panel. " +
        `${ENVIRONMENT_NOTE}`,
      inputSchema: {
        site_id: z.string().uuid().describe("The site's id, from list_sites."),
        plugin_file: z
          .string()
          .describe("The plugin's file, e.g. akismet/akismet.php, from get_inventory."),
        ...CONFIRM_SHAPE,
      },
    },
    async (args) => {
      const { site_id, plugin_file } = args;

      // Order matters, and the tests pin it: permission, then site access,
      // then existence, then the confirm gate. Gating on confirm before site
      // access would tell a caller that a site they cannot see exists.
      const permDenied = requirePermission(ctx.auth, "wp_toolkit.manage");
      if (permDenied) return permDenied;
      if (!canAccessSite(ctx.auth.viewer, site_id, "manage")) return fail(NOT_FOUND);

      const site = await getSite(ctx.sites, site_id);
      if (!site) return fail(NOT_FOUND);

      const gate = gateConfirm(
        ctx.auth,
        args,
        `Would permanently delete the plugin ${plugin_file} from ${site.name} ` +
        `(${site.environment}). Its files are removed and cannot be restored from the panel.`,
        { site: siteSummary(site), plugin_file },
      );
      if (!gate.proceed) return gate.result;

      try {
        const result = await ctx.manageSite(ctx.manage, site_id, ctx.auth.viewer.id, {
          kind: "delete_plugin", file: plugin_file,
        });
        await ctx.audit("mcp.delete_plugin", site_id, {
          reason: gate.reason, args: redactArgs(args), ok: result.ok,
        });
        return result.ok
          ? ok({ site: siteSummary(site), plugin_file, output: result.output })
          : fail(result.error ?? "The site rejected the deletion.");
      } catch (e) {
        return fail(friendlySiteError(e));
      }
    },
  );

  // The remaining ten single-site tools follow, each with its own description,
  // inputSchema, preview sentence and ManageAction from this task's table.
}
```

`ctx.manageSite`, `ctx.cancelBatch`, `ctx.gsc` and `ctx.enqueueBatch` are seams on `ToolCtx` — add them to `src/mcp/context.ts`, defaulting in `buildToolCtx` to the real `manageSite`, the existing batch-cancel action, the GSC service functions and `enqueueBatch`. Injecting them is what lets the dry-run tests assert that **no** service call happened; importing them directly would make that unprovable.

- [ ] **Step 4: Write `fleet.ts`, `gsc.ts`, and `cancel_batch`**

`update_all_plugins_fleet` takes `environment: z.enum(["production","staging"])` plus `CONFIRM_SHAPE`, resolves the viewer's visible sites in that environment via `listSitesForViewer`, previews the full site list by name and environment, and on confirm calls `ctx.enqueueBatch(ctx.jobs, "update_all_plugins", siteIds, {})`, auditing once with `siteId: null`. It must refuse with a clear message when the resolved list is empty rather than enqueueing an empty batch — `enqueueBatch` throws "Select at least one site".

The GSC tools call `ctx.gsc.install` / `ctx.gsc.remove`, which wrap `installVerificationFile` / `removeVerificationFile`; read `src/services/gsc/service.ts` for the exact parameters and `GscDeps` shape.

- [ ] **Step 5: Register the groups and run the tests**

Add `manage`, `fleet` and `gsc` to `GROUPS` in `src/mcp/server.ts`.

Run: `npm test -- tests/mcp-tools-destructive.test.ts`
Expected: PASS, 76 tests (15 tools × 5, plus the coverage assertion).

- [ ] **Step 6: Commit**

```bash
git add src/mcp tests/mcp-tools-destructive.test.ts
git commit -m "feat(mcp): destructive manage, fleet and GSC tools behind a confirm gate"
```

---

### Task 11: The structural pins

**Files:**
- Create: `tests/mcp-tools-structure.test.ts`

Carries pins 2 and 8 across the whole tool surface at once. A source scan catches what a behavioural test cannot: a tool added later that quietly reaches past the service layer, or ships without the environment warning.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const TOOL_DIR = path.resolve(__dirname, "../src/mcp/tools");
const files = readdirSync(TOOL_DIR).filter((f) => f.endsWith(".ts"));

describe("tool files stay above the service layer", () => {
  it("finds the tool files at all", () => {
    // A path typo would make every it.each below vacuously pass.
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)("%s reaches no repo, table or Supabase client", (file) => {
    const src = readFileSync(path.join(TOOL_DIR, file), "utf8");
    // A tool that queries directly bypasses the authorization and audit
    // behaviour every service function carries, and no behavioural test would
    // notice as long as the query happened to return the right rows.
    expect(src, `${file} constructs a repo`).not.toMatch(/Repo\(/);
    expect(src, `${file} queries a table directly`).not.toMatch(/\.from\("/);
    expect(src, `${file} builds a Supabase client`).not.toMatch(/createServiceSupabase/);
    expect(src, `${file} uses ctx.db`).not.toMatch(/ctx\.db/);
  });

  it.each(files)("%s gives every tool an environment warning", (file) => {
    const src = readFileSync(path.join(TOOL_DIR, file), "utf8");
    const registrations = src.match(/registerTool\(/g)?.length ?? 0;
    const notes = src.match(/ENVIRONMENT_NOTE/g)?.length ?? 0;
    expect(notes, `${file}: ${registrations} tools but ${notes} environment notes`)
      .toBeGreaterThanOrEqual(registrations);
  });
});

describe("destructive tools all take the confirm shape", () => {
  it("every destructive tool's registration spreads CONFIRM_SHAPE", async () => {
    const { DESTRUCTIVE_TOOLS } = await import("@/mcp/tools/manage");
    const all = files.map((f) => readFileSync(path.join(TOOL_DIR, f), "utf8")).join("\n");
    for (const name of DESTRUCTIVE_TOOLS) {
      const idx = all.indexOf(`"${name}",`);
      expect(idx, `${name} is never registered`).toBeGreaterThan(-1);
      // A destructive tool without CONFIRM_SHAPE would act immediately, with
      // no dry run and no reason recorded.
      const block = all.slice(idx, idx + 2000);
      expect(block, `${name} does not spread CONFIRM_SHAPE`).toContain("...CONFIRM_SHAPE");
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/mcp-tools-structure.test.ts`
Expected: PASS. If a tool file fails the repo scan, move the query into a service function — do not relax the assertion.

- [ ] **Step 3: Mutation-check the pins**

A structural test that cannot fail is worse than none, and a silent no-op has made a weak test look strong in this project before. Verify each assertion bites:

1. Add `const x = createServiceSupabase();` to `src/mcp/tools/sites.ts`. Run — it **must** fail. Revert.
2. Remove `ENVIRONMENT_NOTE` from one description in `src/mcp/tools/inventory.ts`. Run — it **must** fail. Revert.
3. Remove `...CONFIRM_SHAPE` from `delete_plugin`'s `inputSchema`. Run — it **must** fail. Revert.

Confirm each mutation actually reached the file before judging the result, then confirm the tree is clean: `git status --porcelain` shows only the new test file.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp-tools-structure.test.ts
git commit -m "test(mcp): pin that no tool bypasses the service layer"
```

---

### Task 12: Token management UI on `/users/[id]`

**Files:**
- Create: `src/app/(dashboard)/users/[id]/token-actions.ts`
- Create: `src/app/(dashboard)/users/[id]/api-tokens-card.tsx`
- Modify: `src/app/(dashboard)/users/[id]/page.tsx` (render the card)
- Create: `tests/mcp-token-actions.test.ts`

**Interfaces:**
- Consumes: `mintToken`, `listTokens`, `revokeToken` (Task 3); `supabaseTokensRepo` (Task 3); `requireUser`, `createServiceSupabase`; `checkPermission`, `isDenied`.
- Produces:

```ts
export async function createTokenAction(
  targetUserId: string,
  _prev: { ok: boolean; secret?: string; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; secret?: string; error?: string }>;
export async function revokeTokenAction(tokenId: string): Promise<{ ok: boolean; error?: string }>;
```

Authorization, per spec §Token management UI: a user may create and revoke **their own** tokens; `users.manage` may revoke anyone's and list anyone's; **nobody** may create a token for another user.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-token-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string },
  permission: "denied" as "denied" | "allowed",
  owners: {} as Record<string, string>,
  revoked: [] as string[],
  minted: [] as Record<string, unknown>[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: async () => state.user,
  createServiceSupabase: () => ({}),
  createServerSupabase: async () => ({}),
}));
vi.mock("@/lib/authz/server", () => ({
  checkPermission: async () =>
    state.permission === "allowed"
      ? { id: state.user.id, permissions: new Set(["users.manage"]) }
      : { ok: false, error: "You do not have permission to do that." },
  isDenied: (x: unknown) =>
    typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false,
}));
vi.mock("@/services/tokens/repo", () => ({
  supabaseTokensRepo: () => ({
    getOwner: async (id: string) => (state.owners[id] ? { user_id: state.owners[id] } : null),
    listForUser: async () => [],
  }),
}));
vi.mock("@/services/tokens/service", () => ({
  mintToken: async (_repo: unknown, input: Record<string, unknown>) => {
    state.minted.push(input);
    return { id: "tok-new", secret: "wpcp_brandnewsecret" };
  },
  listTokens: async () => [],
  revokeToken: async (_repo: unknown, id: string) => { state.revoked.push(id); },
}));

import { createTokenAction, revokeTokenAction } from "@/app/(dashboard)/users/[id]/token-actions";

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  state.user = { id: "u1" };
  state.permission = "denied";
  state.owners = {};
  state.revoked = [];
  state.minted = [];
});

describe("createTokenAction", () => {
  it("mints a token for the signed-in user and returns the secret once", async () => {
    const res = await createTokenAction("u1", null, form({ name: "Claude Code", expiry: "30d" }));
    expect(res.ok).toBe(true);
    expect(res.secret).toBe("wpcp_brandnewsecret");
    expect(state.minted).toEqual([
      { userId: "u1", name: "Claude Code", readOnly: false, expiry: "30d" },
    ]);
  });

  it("records the read-only flag when the checkbox is set", async () => {
    await createTokenAction("u1", null, form({ name: "n8n", expiry: "none", read_only: "on" }));
    expect(state.minted[0].readOnly).toBe(true);
  });

  it("refuses to mint a token for somebody else, even as an admin", async () => {
    state.permission = "allowed";
    const res = await createTokenAction("u2", null, form({ name: "x", expiry: "none" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/yourself/i);
    expect(state.minted).toEqual([]);
  });

  it("requires a name", async () => {
    const res = await createTokenAction("u1", null, form({ name: "  ", expiry: "none" }));
    expect(res.ok).toBe(false);
    expect(state.minted).toEqual([]);
  });

  it("rejects an unknown expiry rather than defaulting silently", async () => {
    const res = await createTokenAction("u1", null, form({ name: "x", expiry: "forever" }));
    expect(res.ok).toBe(false);
    expect(state.minted).toEqual([]);
  });
});

describe("revokeTokenAction", () => {
  it("lets a user revoke their own token", async () => {
    state.owners["tok-1"] = "u1";
    const res = await revokeTokenAction("tok-1");
    expect(res.ok).toBe(true);
    expect(state.revoked).toEqual(["tok-1"]);
  });

  it("refuses to revoke another user's token without users.manage", async () => {
    state.owners["tok-2"] = "u2";
    const res = await revokeTokenAction("tok-2");
    expect(res.ok).toBe(false);
    expect(state.revoked).toEqual([]);
  });

  it("lets users.manage revoke anyone's token", async () => {
    state.owners["tok-2"] = "u2";
    state.permission = "allowed";
    const res = await revokeTokenAction("tok-2");
    expect(res.ok).toBe(true);
    expect(state.revoked).toEqual(["tok-2"]);
  });

  it("reports a token that does not exist", async () => {
    const res = await revokeTokenAction("tok-missing");
    expect(res.ok).toBe(false);
    expect(state.revoked).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-token-actions.test.ts`
Expected: FAIL — cannot resolve the actions module.

- [ ] **Step 3: Write `token-actions.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireUser, createServiceSupabase } from "@/lib/supabase/server";
import { checkPermission, isDenied } from "@/lib/authz/server";
import { supabaseTokensRepo } from "@/services/tokens/repo";
import { mintToken, revokeToken } from "@/services/tokens/service";
import type { TokenExpiry } from "@/services/tokens/types";

const EXPIRIES: TokenExpiry[] = ["none", "30d", "90d", "1y"];

export async function createTokenAction(
  targetUserId: string,
  _prev: { ok: boolean; secret?: string; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; secret?: string; error?: string }> {
  const user = await requireUser();

  // Nobody mints a token for somebody else -- not even an admin. A token is an
  // impersonation of its owner, so issuing one on another person's behalf
  // would let an admin act as them with nothing in the audit trail to show it
  // was not really them.
  if (targetUserId !== user.id) {
    return { ok: false, error: "You can only create API tokens for yourself." };
  }

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Give the token a name." };
  if (name.length > 80) return { ok: false, error: "The name must be 80 characters or fewer." };

  const rawExpiry = String(formData.get("expiry") ?? "");
  const expiry = EXPIRIES.find((e) => e === rawExpiry);
  if (!expiry) return { ok: false, error: "Choose a valid expiry." };

  const readOnly = formData.get("read_only") !== null;

  try {
    const { secret } = await mintToken(supabaseTokensRepo(createServiceSupabase()), {
      userId: user.id, name, readOnly, expiry,
    });
    revalidatePath(`/users/${user.id}`);
    return { ok: true, secret };
  } catch (e) {
    console.error("[tokens] mint failed:", e);
    return { ok: false, error: "Could not create the token. Try again." };
  }
}

export async function revokeTokenAction(
  tokenId: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const repo = supabaseTokensRepo(createServiceSupabase());

  const owner = await repo.getOwner(tokenId);
  if (!owner) return { ok: false, error: "Token not found." };

  if (owner.user_id !== user.id) {
    const gate = await checkPermission("users.manage");
    if (isDenied(gate)) return { ok: false, error: gate.error };
  }

  try {
    await revokeToken(repo, tokenId);
    revalidatePath(`/users/${owner.user_id}`);
    return { ok: true };
  } catch (e) {
    console.error("[tokens] revoke failed:", e);
    return { ok: false, error: "Could not revoke the token. Try again." };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/mcp-token-actions.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Build the card**

`api-tokens-card.tsx` is a Client Component using `useActionState` with `createTokenAction` bound to the profile's user id, matching the surrounding cards on `/users/[id]`. It shows:

- **Create form:** name (required), expiry select (`none` / `30d` / `90d` / `1y`), and a read-only checkbox labelled "Read-only (can list and inspect, cannot change anything)".
- **On success:** the secret in a copy box with the exact words **"This will not be shown again."** Reuse the existing copy-to-clipboard component — `tests/copy-button-secret.test.ts` already exists, so follow what it covers.
- **List:** name, `token_prefix` followed by an ellipsis, created, last used or "never", a read-only badge, expired/revoked state, and a Revoke button behind the existing `ConfirmDialog`.
- **Connect snippet** below the list, with the token as a placeholder, never a real secret:

```
claude mcp add --transport http wp-control-panel <APP_URL>/api/mcp \
  --header "Authorization: Bearer <your token>"
```

Hide the create form on someone else's profile. Show their list (never a secret — it does not exist) when the viewer holds `users.manage`.

- [ ] **Step 6: Run the impeccable UI pass**

This card is user-facing, so the project's standing rule applies: run `/impeccable` on it before it ships, and make it work at 375px. Note in the commit message that it was run.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/users/[id]" tests/mcp-token-actions.test.ts
git commit -m "feat(tokens): API tokens card on the user profile"
```

---

### Task 13: Full-suite pass, live smoke test, and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-12-panel-mcp-server-design.md` (status line, and the tool count if Task 10's question changed it)
- Modify: `README.md`

- [ ] **Step 1: Run the entire suite, not just the new files**

Run: `npm test`
Expected: every test passes — the 95 pre-existing files plus the 9 new ones. Do **not** pipe through `grep`: a pipeline returns the exit status of its last command, which has silently hidden a failing suite in this project before. Read the summary line.

- [ ] **Step 2: Type-check and build**

Run: `npx tsc --noEmit`
Then: `npm run build`
Expected: both clean, with `/api/mcp` listed as a dynamic route.

- [ ] **Step 3: Smoke test with a real MCP client**

Mint a token through the new UI, then:

```bash
claude mcp add --transport http wp-control-panel http://localhost:3000/api/mcp \
  --header "Authorization: Bearer $TOKEN"
```

Verify each of these by hand and write down the result. Run every destructive check against a **staging** site only:

1. `list_sites` returns the sites this user can see, each with an `environment`.
2. `get_inventory` on one site returns plugins and themes.
3. `delete_plugin` **without** `confirm` returns a dry run and changes nothing — prove it by re-reading the inventory.
4. `delete_plugin` with `confirm: true` and no `reason` is refused.
5. A **read-only** token's `delete_plugin` with `confirm: true` and a reason is refused, naming the token.
6. A revoked token gets a 401.
7. `activity_log` holds exactly one `mcp.*` row per action that actually ran, and none for any read.

- [ ] **Step 4: Update the spec status and README**

In the spec, change `**Status:** Approved design, awaiting implementation plan` to `**Status:** Implemented 2026-09-12`, and correct the tool count if Task 10's question changed it.

Add to `README.md`:

```markdown
## MCP server

The panel exposes itself over MCP at `POST /api/mcp` (Streamable HTTP, stateless).
Mint a per-user token on your own profile page under **API tokens**, then:

    claude mcp add --transport http wp-control-panel https://<app>/api/mcp \
      --header "Authorization: Bearer <token>"

A token inherits exactly its owner's role, permissions and site grants — it can
never do more than the person who created it. Read-only tokens can inspect
everything they can see and change nothing. Destructive tools are dry-run by
default and need `confirm: true` plus a `reason`, which is recorded in the
activity log.
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-12-panel-mcp-server-design.md
git commit -m "docs(mcp): record the MCP server as implemented"
```

---

## Self-review

**Spec coverage.** Tokens table → Task 3. Identity (`loadViewer`, `authenticateToken`, `applyReadOnly`) → Tasks 2, 4. Transport → Task 7. Tools table → Tasks 6, 8, 9, 10. Confirm → Tasks 5, 10. Audit → Tasks 9, 10. Token management UI → Task 12. Errors and edge cases → Task 4 (null on every auth failure; `last_used_at` failure tolerated), Task 6 (not-found rather than forbidden), Task 7 (401 with challenge, 405). Test pins map: 1 → Task 2; 2 → Task 11; 3, 4 → Tasks 5, 10; 5 → Task 3; 6 → Task 9; 7 → Task 7; 8 → Tasks 6, 8, 11.

**Two things the implementer must raise rather than decide alone.**

1. **Tool count.** The spec's prose says twenty-eight, its table lists twenty-seven rows, and `ManageAction` supports three more kinds the UI exposes (`activate_theme`, `delete_theme`, `flush_permalinks`). Task 10 opens with this question instead of silently shipping a different number.
2. **`package.json` has no `version` field**, so the spec's "version from `package.json`" cannot be satisfied as written. Task 1 Step 4 adds `"version": "0.1.0"`.

**Two verification steps exist because an assumption might be wrong, not to pad the plan.** Task 1 proves zod 4 survives the SDK's JSON Schema conversion before every tool depends on it — the failure mode is an empty `properties` object, which means tools silently accept anything rather than erroring. Task 7 Step 4 checks whether `handleRequest` takes a web `Request` or Node's `IncomingMessage` in SDK 1.30. Both would otherwise surface late.

**Type consistency check.** `ToolCtx` gains fields across Tasks 6, 8, 9 and 10 (`auth`, `sites`, `manage`, `jobs`, `audit`, then `inventory`/`security`/`seo`/`geogrid`/`reports`/`jobsRead`, then the `manageSite`/`cancelBatch`/`gsc`/`enqueueBatch` seams). Each task states what it adds, and no task references a field an earlier task did not introduce. `siteSummary` and `NOT_FOUND` are defined once in `tools/sites.ts` (Task 6) and imported by every later group. `requirePermission` and `requireWritableToken` are defined in Task 5 and used from Task 9 onward — not introduced mid-plan.

**Deliberately not carried over from the spec:** OAuth 2.1 with dynamic client registration, per-token rate limiting, per-token site scoping beyond the user's grants, user/role/permission tools, and MCP resources and prompts — all named out of scope there.
