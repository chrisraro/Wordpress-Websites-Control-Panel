# Panel MCP Server — Design

**Date:** 2026-09-12
**Status:** Implemented 2026-09-12

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

Deploy order: this migration must be applied before a build containing this
feature serves traffic, because `/users/[id]` existed and worked before the
table did. If it has not been, `/users/[id]` and `/account` still render — the
token list is read through `listTokensOrUnavailable`, which turns the missing
relation into an empty list plus a one-line hint in the API tokens card ("API
tokens are unavailable — the `api_tokens` migration has not been applied") and
logs the real error server-side; minting and revoking still fail loudly.

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
    `loadViewer(user_id)`, apply `read_only`, stamp `last_used_at`. The stamp
    is **awaited** deliberately, not fire-and-forget: this app deploys to
    Vercel, where a function can freeze the moment the response is returned
    and a floating promise may simply never land. A failed stamp is caught
    and logged and must not fail the request.
  - `TokenAuth = { viewer: Viewer; tokenId: string; readOnly: boolean }`.
  - `applyReadOnly(viewer): Viewer` — keeps only the permissions classified
    `"read"` in `PERMISSION_KIND`, an exhaustive `Record<AppPermission, "read"
    | "write">` table (adding a permission without classifying it fails
    `tsc`; a test pins the key set to `APP_PERMISSIONS`) — not suffix
    matching; downgrades every site grant to `read`. Pure, tested.

The property this buys: a token-authenticated `Viewer` and a cookie-authenticated
`Viewer` for the same user are built by the same function and are identical. A
test pins it.

### Transport

`src/app/api/mcp/route.ts`:

- `export const dynamic = "force-dynamic"; export const maxDuration = 300;`
- `POST`: read `Authorization: Bearer <secret>`; missing or invalid →
  `401` with `WWW-Authenticate: Bearer realm="wp-control-panel"`. Valid → build
  an `McpServer` with the tools registered against this request's `TokenAuth`,
  attach a `WebStandardStreamableHTTPServerTransport` with
  `sessionIdGenerator: undefined` (stateless) and `enableJsonResponse: true`,
  and hand it the request.
- `GET` and `DELETE`: `405`. Stateless mode has no server-initiated stream and
  no session to end.
- Server info: name `wp-control-panel`, version from `package.json`.

Stateless is required, not chosen: consecutive requests may land on different
Vercel instances, and there is no shared session store. Every request carries
its own auth and is complete in itself.

The web-standard transport, not the Node one, is what this route needs: its
`handleRequest` takes a web-standard `Request` and returns a `Response`, which
is what a Next.js route handler signs up to hand back, where the Node variant
expects `IncomingMessage`/`ServerResponse`. `enableJsonResponse: true` is
required rather than cosmetic — the default SSE mode returns a streaming
response body that the route fills in later via `send()`, and closing the
transport in the route's `finally` block (needed regardless, to release it)
would shut that stream before any tool result reached it, truncating every
response to empty. 300 seconds, not 60: the `manage` tools' own seams already
run up to 180–270 seconds (`ACTION_TIMEOUT_MS`, `HEAVY_TIMEOUT_MS` in
`src/services/manage/service.ts`), and a route ceiling below that would have
the platform kill the request before a tool's own timeout ever had the chance
to fire cleanly.

### Tools

Location: `src/mcp/tools/<group>.ts`, one file per group, each exporting
`register(server, ctx)` where `ctx: ToolCtx` carries `auth: TokenAuth` plus
narrowed accessors (`sites`, `manage`, `jobs`, `inventory`, `security`, `seo`,
`geogrid`, `reports`, `jobsRead`) and injected seams for the writes
(`manageSite`, `enqueueBatch`, `planFleetPluginUpdate`, `gsc`, `audit`). There
is deliberately no `db` on `ToolCtx`: a tool never sees a Supabase client. A single
`src/mcp/server.ts` builds the server and calls every group's `register`.

Every tool:
- validates its arguments with a schema (the SDK's zod integration);
- reaches data only through the narrowed accessors and seams on `ctx`, with
  `ctx.auth.viewer` (or the viewer's id as actor); a tool file never
  constructs a repo, calls `.from(`, or creates a Supabase client —
  `tests/mcp-tools-structure.test.ts` source-scans `src/mcp/tools/` to forbid
  all three;
- returns `{ content: [{ type: "text", text: JSON }] }` on success, and
  `{ isError: true, content: [...friendlySiteError text...] }` on failure.
  A missing permission names the permission. A missing site grant returns
  "Site not found." — never a message naming the grant, because the
  existence of a site is itself information (see Errors and edge cases).

Every result that names a site includes `environment: "production" | "staging"`.
Every tool description states that sites carry an environment and that staging
and production must not be confused.

| Group | Tool | Kind | Service |
|---|---|---|---|
| sites | `list_sites` | read | `listSitesForViewer` |
| sites | `get_site` | read | `getSite` |
| sites | `test_site_connection` | read, but needs `sites.manage` and a writable token; audited as `mcp.test_site_connection` | `testSiteConnection` |
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
| manage | `update_themes` | **destructive** | `manageSite` `update_theme`, one `slug` per call |
| manage | `update_core` | **destructive** | `manageSite` `update_core` |
| manage | `activate_plugin` | **destructive** | `manageSite` |
| manage | `deactivate_plugin` | **destructive** | `manageSite` |
| manage | `delete_plugin` | **destructive** | `manageSite` |
| manage | `activate_theme` | **destructive** | `manageSite` |
| manage | `delete_theme` | **destructive** | `manageSite` |
| manage | `set_maintenance` | **destructive** | `manageSite` `maintenance` |
| manage | `flush_cache` | **destructive** | `manageSite` `flush_cache` |
| manage | `flush_permalinks` | **destructive** | `manageSite` |
| fleet | `update_all_plugins_fleet` | **destructive** | same logic as `updateAllPluginsAction(env)` |
| gsc | `install_gsc_verification` | **destructive** | `installVerificationFile` |
| gsc | `remove_gsc_verification` | **destructive** | `removeVerificationFile` |

Thirty-one tools (fifteen destructive). `get_site` is deliberately narrowed to the
site record itself; it does not also fold in the latest snapshot summary, grade,
or `gscStatus` as originally sketched — an LLM composes those by calling
`get_inventory`, `get_security` and `get_seo` alongside it, which keeps each tool's
result single-purpose and avoids paying for data the caller didn't ask for. The
three additional `manage` rows above (`activate_theme`, `delete_theme`,
`flush_permalinks`) were added during implementation: `ManageAction` already
supported these kinds and the UI already exposed them, so leaving them out of the
MCP surface would have been an arbitrary gap. **Excluded:** user, role and
permission management. Granting a permission is the one write that widens every
other write; there is no conversational use for it that a person should not do by
hand.

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
- On a `read_only` token, every destructive tool returns `isError: true` with
  text saying the **token** is read-only (distinct from a permission denial,
  which names the missing permission — the fixes differ). This is decided at
  the permission step, before the confirm gate: `applyReadOnly` has stripped
  the tool's write permission, and `requirePermission` recognises that a
  read-only token missing a *write* permission should be told to mint a
  writable token, not to ask for a permission it already holds. A read-only
  token therefore cannot preview a destructive tool either — `confirm: false`
  is refused the same way. (A read-only token missing a *read* permission is
  still told which permission it lacks.)
- An enqueue tool whose job is already pending (`enqueueJob` returns `null`)
  reports `queued: false` and writes **no** audit row — `activity_log` records
  changes, and "already queued" is not one. `cancel_batch` with nothing pending
  behaves the same.

Preview text is generated by a small pure function per tool so it is testable
without a site.

Every tool on the MCP route makes at most **one** `manageSite` call per
invocation. `update_themes` therefore takes a single `slug` (it keeps its name
for continuity; call it once per theme). A multi-slug loop would break the
audit rule — a throw on the second slug leaves the first updated with no row —
and two `ACTION_TIMEOUT_MS` calls would outrun the route's `maxDuration`.

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
them. `test_site_connection` is the one non-destructive tool that is audited
(`mcp.test_site_connection`, with `token_id`): the service already writes a
`site.test_connection` row, exactly as a panel click does, and the `mcp.` row
is what makes a token-driven probe distinguishable from that click. A
performed or attempted live action is audited whether its seam reports
failure by return value (e.g. `manageSite`'s `{ ok: false, error }`) or by
throwing — both write a row with the failure recorded in `detail`; read-side
failures before the act (a missing permission, a site not visible, a bad
confirm/reason) are not audited, since nothing was attempted. `cancel_batch`
cancels exactly the pending jobs on sites the caller can see — the previewed
set — never the whole batch, so a job on a site outside the caller's grants is
never touched even though it shares the batch id.

### Token management UI

`/users/[id]` is gated `users.manage`, which only `admin` holds by default — a
card there would have been unreachable for developers, content writers and
clients who need to mint their own token. The self-service surface is instead a
new `/account` page, guarded by `requireViewer()` (any signed-in user holding a
role, not a specific permission), showing only the viewer's own tokens with a
full **API tokens** card:

- **Create**: name (required), expiry (none / 30d / 90d / 1y), read-only toggle.
  On success, the secret is shown once in a copy box with "This will not be shown
  again." The list refreshes.
- **List**: name, `token_prefix…`, created, last used (or "never"), read-only
  badge, expired/revoked state, Revoke button with a `ConfirmDialog`.
- **Connect** snippet under the list: the `claude mcp add --transport http
  wp-control-panel <APP_URL>/api/mcp --header "Authorization: Bearer <token>"`
  command and equivalent JSON for Cursor and n8n, with the token as a placeholder.

`/users/[id]` keeps an API tokens card of its own, but read-only: the same list
(name, prefix, created, last used, read-only badge, expired/revoked state) with
a Revoke button for `users.manage` holders, and **no** create form — nobody
mints a token for another user, themselves included, from that page. The
signed-in user's email in the sidebar links to `/account`, so every role has a
one-click way back to their own tokens.

Authorization: a user may create and revoke their own tokens, from `/account`
only. `users.manage` may revoke anyone's and see anyone's list from
`/users/[id]` (never the secret — it does not exist), but cannot create one.

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
- `last_used_at` stamp failure → logged, request proceeds (the stamp is
  awaited, so the failure is seen and logged in-request — see Identity).

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
src/services/geogrid/enqueue.ts
src/services/manage/fleet.ts
src/mcp/server.ts                    (buildServer(auth, deps))
src/mcp/tools/{sites,inventory,security,seo,geogrid,reports,jobs,manage,fleet,gsc}.ts
src/mcp/confirm.ts                   (shared confirm/preview/audit helpers)
src/app/api/mcp/route.ts
src/app/(dashboard)/account/page.tsx
src/app/(dashboard)/users/[id]/token-actions.ts
src/app/(dashboard)/users/[id]/api-tokens-card.tsx
tests/helpers/mcp-ctx.ts
tests/mcp-identity.test.ts
tests/mcp-tools-sites.test.ts
tests/mcp-tools-reads.test.ts
tests/mcp-tools-destructive.test.ts
tests/mcp-confirm.test.ts
tests/mcp-context.test.ts
tests/mcp-tokens.test.ts             (pin 5)
tests/mcp-tokens-repo.test.ts
tests/mcp-token-actions.test.ts
tests/mcp-audit.test.ts              (pin 6)
tests/mcp-route.test.ts              (pin 7)
tests/jobs-repo-cancel-jobs.test.ts
tests/jobs-repo-list-jobs.test.ts
tests/reports-repo-get-by-id.test.ts
tests/geogrid-enqueue.test.ts
tests/manage-fleet.test.ts
```
