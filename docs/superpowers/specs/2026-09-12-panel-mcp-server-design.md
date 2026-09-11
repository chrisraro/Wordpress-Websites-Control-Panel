# Panel MCP Server — Design

**Date:** 2026-09-12
**Status:** Approved design, awaiting implementation plan

## Goal

Expose the WP Control Panel to LLM clients over the Model Context Protocol, so an
LLM can read every site's state and take the same actions the UI offers — through
the existing service layer and its permission model, never around it.

## Context

The panel already has the pieces this depends on:

- A `Viewer` (`src/lib/authz/decide.ts`) built from a user id plus `user_roles`,
  `user_permission_overrides`, `user_site_access`, and `role_permissions`. Every
  server action checks a `Viewer` via `checkPermission` / `checkSiteAccess`.
- A service layer (`src/services/*`) that takes explicit deps and a `Viewer` or
  actor id, and is already unit-tested in isolation.
- A job queue (`jobs` table, `enqueueJob` / `enqueueBatch`, pg_cron drain) that
  runs anything slow outside the request, with a batch page for progress and
  cancellation.
- `activity_log` for attributed changes.
- The panel is itself an MCP *client* (`@modelcontextprotocol/sdk`, Streamable
  HTTP) to Novamira on each WordPress site, so the SDK is already a dependency.

Clients to support: Claude Code, Cursor and other MCP clients, unattended
automations (n8n), and claude.ai custom connectors. The first three take a bearer
token today. claude.ai expects OAuth; that is a **separate follow-on spec** and
is out of scope here, but the token table below is what it will build on.

## Decisions

1. **Identity: per-user tokens.** An LLM acts as the person who minted the token
   and inherits exactly that person's role, permissions and site grants. No agent
   user, no scope language. The one per-token restriction is `read_only`.
2. **Transport: a route inside the panel**, `/api/mcp`, Streamable HTTP in
   stateless mode. Same deploy, same env, same authz code.
3. **Write scope: everything the UI can do**, with destructive tools requiring
   `confirm: true` and a `reason`, and returning a dry-run preview otherwise.
4. **Slow work is enqueued**, never run inside the request. Tools return a job or
   batch id; the LLM polls `get_batch`.

## Architecture

```
MCP client ──Bearer wpcp_…──▶ /api/mcp (Next.js route, stateless Streamable HTTP)
                                  │
                                  ├─ authenticateToken()  → Viewer (via loadViewer)
                                  │
                                  └─ McpServer tools ──▶ src/services/*  (existing)
                                                            │
                                                            ├─ Supabase (via repos)
                                                            ├─ jobs queue (enqueue)
                                                            └─ activity_log (audit)
```

### Tokens

Migration `0021_api_tokens.sql`:

```sql
create table api_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,      -- sha256(secret), hex
  token_prefix  text not null,             -- first 8 chars of the secret, for display
  read_only     boolean not null default false,
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index on api_tokens (user_id);
```

RLS: service-role only. The panel reads and writes this table exclusively through
`createServiceSupabase()` after its own authz checks, the same as the other
credential-adjacent tables.

Secret format: `wpcp_` + base64url of 32 random bytes (43 chars). Generated
server-side, shown once, never stored. `token_hash` is sha256 of the whole
secret including the prefix.

Why a hash rather than encryption: the panel never needs the secret back, so
nothing that can read the database can produce a usable token. Site application
passwords are encrypted rather than hashed because they *must* be recovered to
be used; tokens have no such need.

### Identity

`src/lib/authz/server.ts`:

- Extract the second half of `getViewer` into `loadViewer(userId: string):
  Promise<Viewer | null>` — the role/overrides/grants/role_permissions loading,
  including every fail-closed branch, unchanged.
- `getViewer` (session) becomes: read the session user id, call `loadViewer`.
- New `src/lib/authz/token.ts`:
  - `authenticateToken(secret: string, db): Promise<TokenAuth | null>` — hash,
    look up, reject when `revoked_at` is set or `expires_at` is past, call
    `loadViewer(user_id)`, apply `read_only`, stamp `last_used_at`
    (fire-and-forget; a failed stamp must not fail the request).
  - `TokenAuth = { viewer: Viewer; tokenId: string; readOnly: boolean }`.
  - `applyReadOnly(viewer): Viewer` — removes every permission ending in
    `.manage`, `.run`, `.generate`, `.process`; downgrades every site grant to
    `read`. Pure, tested.

The property this buys: a token-authenticated `Viewer` and a cookie-authenticated
`Viewer` for the same user are built by the same function and are identical. A
test pins it.

### Transport

`src/app/api/mcp/route.ts`:

- `export const dynamic = "force-dynamic"; export const maxDuration = 60;`
- `POST`: read `Authorization: Bearer <secret>`; missing or invalid →
  `401` with `WWW-Authenticate: Bearer realm="wp-control-panel"`. Valid → build
  an `McpServer` with the tools registered against this request's `TokenAuth`,
  attach a `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`
  (stateless), and hand it the request.
- `GET` and `DELETE`: `405`. Stateless mode has no server-initiated stream and
  no session to end.
- Server info: name `wp-control-panel`, version from `package.json`.

Stateless is required, not chosen: consecutive requests may land on different
Vercel instances, and there is no shared session store. Every request carries
its own auth and is complete in itself.

### Tools

Location: `src/mcp/tools/<group>.ts`, one file per group, each exporting
`register(server, ctx)` where `ctx = { auth: TokenAuth, db, deps }`. A single
`src/mcp/server.ts` builds the server and calls every group's `register`.

Every tool:
- validates its arguments with a schema (the SDK's zod integration);
- calls a `src/services/*` function with `ctx.auth.viewer` (or the viewer's id as
  actor), never a repo directly;
- returns `{ content: [{ type: "text", text: JSON }] }` on success, and
  `{ isError: true, content: [...friendlySiteError text...] }` on failure.
  Authorization failures name the missing permission or site grant.

Every result that names a site includes `environment: "production" | "staging"`.
Every tool description states that sites carry an environment and that staging
and production must not be confused.

| Group | Tool | Kind | Service |
|---|---|---|---|
| sites | `list_sites` | read | `listSitesForViewer` |
| sites | `get_site` | read | `getSite` + latest snapshot summary + latest grade + `gscStatus` |
| sites | `test_site_connection` | read | `testSiteConnection` |
| inventory | `get_inventory` | read | `latestSnapshot` (plugins, themes, core, maintenance, gsc) |
| inventory | `refresh_inventory` | enqueue | `enqueueJob("snapshot_refresh")` |
| security | `get_security` | read | `latestGrade`, `openVulns`, `latestChecks` |
| security | `run_security_scan` | enqueue | `enqueueJob("security_scan")` |
| seo | `get_seo` | read | latest `seo_snapshots` per source |
| seo | `run_seo_scan` | enqueue | `enqueueJob("seo_scan")` |
| geogrid | `get_geogrid` | read | latest run + config |
| geogrid | `run_geogrid` | enqueue | existing geogrid enqueue |
| reports | `list_reports` | read | reports repo |
| reports | `generate_report` | enqueue | `enqueueJob("report_generate")` |
| reports | `get_report_link` | read | existing share-link resolution |
| jobs | `list_jobs` | read | jobs repo, scoped to visible sites |
| jobs | `get_batch` | read | same data as `/api/batches/[id]` |
| jobs | `cancel_batch` | **destructive** | existing cancel action |
| manage | `update_plugins` | **destructive** | `manageSite` `update_all_plugins` / `update_plugin` |
| manage | `update_themes` | **destructive** | `manageSite` `update_theme` per slug |
| manage | `update_core` | **destructive** | `manageSite` `update_core` |
| manage | `activate_plugin` | **destructive** | `manageSite` |
| manage | `deactivate_plugin` | **destructive** | `manageSite` |
| manage | `delete_plugin` | **destructive** | `manageSite` |
| manage | `set_maintenance` | **destructive** | `manageSite` `maintenance` |
| manage | `flush_cache` | **destructive** | `manageSite` `flush_cache` |
| fleet | `update_all_plugins` | **destructive** | same logic as `updateAllPluginsAction(env)` |
| gsc | `install_gsc_verification` | **destructive** | `installVerificationFile` |
| gsc | `remove_gsc_verification` | **destructive** | `removeVerificationFile` |

Twenty-eight tools. **Excluded:** user, role and permission management. Granting a
permission is the one write that widens every other write; there is no
conversational use for it that a person should not do by hand.

`manage` tools that run synchronously in the UI (single-site plugin update, etc.)
stay synchronous here too, with the same timeouts — they finish in seconds. The
fleet tool and all scans/reports enqueue.

### Confirm — dry run by default

Every **destructive** tool accepts:

```
confirm?: boolean   // default false
reason?:  string    // required when confirm is true; 10–500 chars
```

- `confirm` absent or `false`: the tool performs no action and returns a preview
  — the sites and items affected, and the same warning text the UI's confirmation
  dialog shows. `isError: false`.
- `confirm: true` without `reason`: `isError: true`, "a reason is required".
- `confirm: true` with `reason`: the action runs; `reason` is written to the audit
  row.
- On a `read_only` token, `confirm: true` returns `isError: true` with text
  saying the **token** is read-only (distinct from a permission denial, which
  names the missing permission — the fixes differ).

Preview text is generated by a small pure function per tool so it is testable
without a site.

### Audit

Every enqueue and every destructive action that runs writes one `activity_log`
row:

```
actor:   token owner's user id
site_id: the site, or null for fleet
action:  "mcp.<tool_name>"
detail:  { token_id, reason, args }   -- args with every key matching /password|secret|token|key/i replaced by "[redacted]"
```

Reads are not logged. `activity_log` records changes; logging reads would bury
them.

### Token management UI

On `/users/[id]` (existing page), a new **API tokens** card:

- **Create**: name (required), expiry (none / 30d / 90d / 1y), read-only toggle.
  On success, the secret is shown once in a copy box with "This will not be shown
  again." The list refreshes.
- **List**: name, `token_prefix…`, created, last used (or "never"), read-only
  badge, expired/revoked state, Revoke button with a `ConfirmDialog`.
- **Connect** snippet under the list: the `claude mcp add --transport http
  wp-control-panel <APP_URL>/api/mcp --header "Authorization: Bearer <token>"`
  command and equivalent JSON for Cursor and n8n, with the token as a placeholder.

Authorization: a user may create and revoke their own tokens. `users.manage` may
revoke anyone's and see anyone's list (never the secret — it does not exist). No
one can create a token for another user.

Server actions in `src/app/(dashboard)/users/[id]/token-actions.ts`, gated as
above, using a `src/services/tokens/` service and repo.

### Errors and edge cases

- Malformed JSON-RPC → the SDK's standard error response.
- Token valid but user has no role (deleted, or bootstrap not run) →
  `loadViewer` returns null → `401`, same as the session path.
- Site not visible to the viewer → tools return the same "not found" the UI
  gives, never "forbidden" — existence of a site is itself information.
- Service throws → `isError` with `friendlySiteError(e)`; the raw error is
  logged server-side, as today.
- `last_used_at` stamp failure → logged, request proceeds.

### Testing

`tests/mcp-*.test.ts`, following the repo's conventions (vitest, fakes over
mocks where the existing tests do, source-scan pins where structure matters):

1. **Identity parity**: `loadViewer(u)` via session path and via token path
   yields deep-equal `Viewer`s.
2. **No tool reaches a repo**: source scan of `src/mcp/tools/` for `Repo(`,
   `.from("`, `createServiceSupabase` — must be absent.
3. **Confirm is enforced on every destructive tool**: an enumerated list in the
   test; each tool called without `confirm` returns a preview and performs no
   service call; with `confirm` but no `reason` returns `isError`.
4. **Read-only tokens cannot write**: an admin's read-only token calling each
   destructive tool with `confirm: true` gets the read-only error and no service
   call.
5. **Token lifecycle**: revoked → null; expired → null; valid → viewer and a
   `last_used_at` stamp; hash never equals secret; prefix matches.
6. **Audit**: every write/enqueue tool produces exactly one `activity_log` row
   with `action = "mcp.<name>"` and no secret in `detail`.
7. **Route**: missing header → 401 with `WWW-Authenticate`; GET → 405.
8. **Environment in results**: every site-returning tool's output includes
   `environment`.

## Out of scope (named)

- OAuth 2.1 authorization server with dynamic client registration, for claude.ai
  custom connectors. Follow-on spec; reuses `api_tokens`.
- Per-token rate limiting.
- Per-token site scoping beyond what the user's grants already provide.
- User/role/permission tools.
- Resources and prompts (MCP primitives beyond tools). Tools cover the need;
  add resources only if a client benefits from them.

## File map

```
supabase/migrations/0021_api_tokens.sql
src/lib/authz/server.ts              (extract loadViewer)
src/lib/authz/token.ts               (authenticateToken, applyReadOnly)
src/services/tokens/{types,repo,service}.ts
src/mcp/server.ts                    (buildServer(auth, deps))
src/mcp/tools/{sites,inventory,security,seo,geogrid,reports,jobs,manage,fleet,gsc}.ts
src/mcp/confirm.ts                   (shared confirm/preview/audit helpers)
src/app/api/mcp/route.ts
src/app/(dashboard)/users/[id]/token-actions.ts
src/app/(dashboard)/users/[id]/api-tokens-card.tsx
tests/mcp-identity.test.ts
tests/mcp-tools-authz.test.ts        (pins 2, 3, 4, 8)
tests/mcp-tokens.test.ts             (pin 5)
tests/mcp-audit.test.ts              (pin 6)
tests/mcp-route.test.ts              (pin 7)
```
