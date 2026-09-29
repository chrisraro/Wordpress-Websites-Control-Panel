# WP Control Panel Codemap

**Last Updated:** 2026-09-29
**Entry Points:** `src/app/layout.tsx`, `src/middleware.ts`, `src/app/api/mcp/route.ts`, `src/app/api/cron/*/route.ts`

## Purpose

Internal OCS agency dashboard (Next.js 15, React 19, Supabase) for managing a fleet of about 12 client WordPress sites. The panel reaches each site through its Novamira MCP endpoint, using a WordPress Application Password stored encrypted. It covers inventory, a plugin/theme toolkit, security scans, SEO/AEO, GeoGrid rank tracking, PDF reports with share links, uptime checks and role-based access. It also exposes itself as an MCP server at `POST /api/mcp`, authenticated by per-user API tokens. Setup and features: `README.md`. Product intent: `PRODUCT.md`.

## Request flow

```
Browser: page (src/app/(dashboard)/**/page.tsx)
  -> server action (colocated actions.ts / *-actions.ts)  --+
MCP client -> POST /api/mcp -> authenticateToken            |
  -> buildServer -> src/mcp/tools/<group>.ts              --+
                                                            v
   permission gate: src/lib/authz (can / canAccessSite)
                                                            v
   src/services/<domain>/service.ts (+ repo.ts, types.ts)
                                                            v
   src/lib/mcp/client.ts   src/lib/crypto/secrets.ts   src/lib/supabase/*
        |                          |                          |
   WordPress site (Novamira)   decrypt site creds       Supabase (RLS)
```

- Pages read through `readDbFor(viewer)` (`src/lib/authz/db.ts`), a user-scoped client, so RLS is the backstop. Services that write use the service-role client from `src/lib/supabase/server.ts`.
- `src/middleware.ts` only refreshes the session and redirects anonymous users. It does no authorization. Public prefixes: `/login`, `/r/`, `/api/cron/`, `/api/webhooks/`.
- MCP tokens resolve to a user, then `loadViewer` (`src/lib/authz/server.ts`) builds the same Viewer as a cookie session. `read_only` tokens drop every permission marked "write" in `PERMISSION_KIND` (`src/lib/authz/token.ts`).
- Destructive MCP tools are dry-run by default; the dry run returns a one-time `confirm_code` (HMAC over user, tool, site and arguments, 10-minute expiry) that the real call must echo with a `reason` (`src/mcp/confirm.ts`).
- Queued jobs re-check the enqueuing user's authority when they run; update jobs pass the pre-update backup gate (`src/services/backup/gate.ts`) and may defer themselves (`DeferJob`) while UpdraftPlus runs.
- Outbound requests to sites go through `src/lib/net-guard.ts` (public addresses only, re-checked on every redirect and at connect time).

## Job flow

```
Supabase pg_cron + pg_net (docs/ops/scheduling.md; vercel.json declares no crons)
  every 1 min -> POST /api/cron/process  -> recoverStaleAwaiting + processJobs(max 3)
  nightly     -> /api/cron/enqueue       -> enqueueJob(...) per site
  every 5 min -> /api/cron/uptime        -> src/services/security/uptime.ts
                     |
                jobs table (claim_jobs(): SKIP LOCKED, retry ladder)
                     |
   buildJobHandlers (src/services/jobs/handlers.ts) -> domain service -> site / Supabase
```

- Cron routes check `x-cron-secret` via `src/lib/cron-auth.ts`.
- Enqueue writes `snapshot_refresh`, `security_scan`, `vuln_feed_refresh`, weekly `seo_scan`, and monthly `report_generate`.
- `geogrid_run` may return `{ awaitingCallback: true }`. The n8n workflow then posts to `/api/webhooks/n8n/geogrid` (`src/lib/n8n-auth.ts`).
- Job types: `snapshot_refresh`, `security_scan`, `vuln_feed_refresh`, `plugin_install` (also themes, via `payload.target`), `seo_scan`, `geogrid_run`, `report_generate`, `bulk_manage`, `update_all_plugins`, `harden`.

## Directory map

| Path | Responsibility | Key entry files |
|---|---|---|
| `src/app/login`, `src/app/page.tsx` | Sign-in, root redirect | `login/page.tsx`, `login/actions.ts` |
| `src/app/(dashboard)/dashboard` | Overview band, needs-attention list, site directory card catalog (search/filter/sort/10 per page in the URL; live sandboxed homepage frames, screenshot fallback), system health | `dashboard/page.tsx`, `site-catalog.tsx`, `site-card.tsx`, `site-preview.tsx`; logic in `src/services/sites/{directory,overview,preview}.ts` |
| `src/app/(dashboard)/sites` | Site list, connect (modal via `@modal/(.)sites/new`), per-site tabs | `sites/[id]/page.tsx`, `sites/[id]/tabs.tsx`, `sites/[id]/actions.ts` |
| `src/app/(dashboard)/sites/[id]/{plugins,themes,security,seo,geogrid,reports}` | One page per site tab; actions live one level up as `*-actions.ts` | `seo/page.tsx`, `seo-actions.ts` |
| `src/app/(dashboard)/marketplace` | wordpress.org search, bulk install, theme tab, batch progress | `marketplace/page.tsx`, `marketplace/batches/[id]/page.tsx` |
| `src/app/(dashboard)/users`, `account` | Invites, roles matrix, grants, API tokens | `users/actions.ts`, `users/roles/matrix.tsx`, `account/page.tsx` |
| `src/app/api/cron/{enqueue,process,uptime}` | pg_cron targets | `*/route.ts` |
| `src/app/api/mcp` | Panel MCP server (Streamable HTTP, stateless) | `route.ts` |
| `src/app/api/{batches,sites/[id]/geogrid-runs,webhooks/n8n/geogrid}` | Batch polling, GeoGrid run API, n8n callback | `*/route.ts` |
| `src/app/r/[token]` | Public revocable report share page and PDF | `page.tsx`, `file/route.ts` |
| `src/services/sites` | Site CRUD, portfolio/staging logic | `service.ts`, `repo.ts`, `portfolio.ts` |
| `src/services/inventory` | Snapshots of WP version, plugins, themes, admin users | `service.ts`, `repo.ts` |
| `src/services/manage` | Plugin/theme actions on a site, fleet planning | `service.ts`, `fleet.ts` |
| `src/services/bulk` | Multi-select bulk actions | `service.ts` |
| `src/services/marketplace`, `themes` | Plugin/theme install, theme delete safety | `marketplace/install.ts`, `themes/install.ts`, `themes/safety.ts` |
| `src/services/childtheme`, `rootfiles` | Child-theme generation, root files | `childtheme/service.ts`, `rootfiles/service.ts` |
| `src/services/security` | Scans, checksums, vulns, hardening, uptime | `scan.ts`, `vulns.ts`, `harden.ts`, `uptime.ts` |
| `src/services/seo` | Rank Math, PSI, GSC collection | `scan.ts`, `collect.ts` |
| `src/services/gsc` | Search Console verification files | `service.ts` |
| `src/services/geogrid` | Grid math, config, runs, enqueue | `run.ts`, `grid.ts`, `enqueue.ts` |
| `src/services/reports` | Gather data, render PDF, share links | `generate.ts`, `gather.ts`, `document.tsx` |
| `src/services/jobs` | Enqueue, claim/process, retry, handlers | `service.ts`, `handlers.ts`, `types.ts` |
| `src/services/users`, `tokens` | User admin and lockout guards; API token repo | `users/guards.ts`, `tokens/service.ts` |
| `src/lib/mcp` | Outbound client for site MCP endpoints | `client.ts`, `connect.ts`, `discover.ts`, `envelope.ts`, `errors.ts` |
| `src/lib/authz` | Roles, permissions, decisions, viewer loading, tokens | `types.ts`, `decide.ts`, `server.ts`, `db.ts`, `token.ts` |
| `src/lib/crypto` | Secret encryption (libsodium, `APP_ENCRYPTION_KEY`) | `secrets.ts` |
| `src/lib/supabase` | Browser and server/service clients | `server.ts`, `browser.ts` |
| `src/lib/{adapters,google}` | wordpress.org, PSI, GA4/GSC clients | `adapters/wporg.ts`, `google/auth.ts` |
| `src/lib` (other) | Env, cron auth, pagination, PHP snippets | `env.ts`, `cron-auth.ts`, `wpphp.ts` |
| `src/mcp` | Panel MCP server: tool groups, per-request context | `server.ts`, `context.ts`, `confirm.ts`, `schema.ts`, `tools/*.ts` |
| `src/components/shell`, `ui` | App shell (sidebar, breadcrumbs, palette); shared primitives | `shell/sidebar.tsx`, `ui/primitives.tsx`, `ui/icons.tsx` |
| `scripts` | Admin bootstrap, site import, live RLS check, client doc build | `bootstrap-admin.ts`, `import-novamira-sites.ts`, `verify-rls.ts` |
| `tests` | Vitest suite, one file per unit or route (`npm test`) | `helpers/mcp-ctx.ts`, `support/find-page-files.ts` |

MCP tool groups (`src/mcp/tools/`): `sites`, `inventory`, `security`, `seo`, `geogrid`, `reports`, `jobs`, `manage`, `fleet`, `gsc`.

### Migrations (`supabase/migrations/`)

| No. | Adds |
|---|---|
| 0001 | Core schema: sites, snapshots, vuln feed, security/uptime/seo/geogrid/report tables, jobs, activity_log, team RLS |
| 0002 | `claim_jobs()` atomic claim (SKIP LOCKED) |
| 0003 | Private `plugins` storage bucket |
| 0004 | Private `reports` storage bucket |
| 0005 | Private `themes` storage bucket |
| 0006 | RBAC enums (`app_role`, `app_permission`), role/permission tables, seeded matrix |
| 0007 | `authorize()`, `authorize_for_user()`, `has_site_access()` functions |
| 0008 | Scoped RLS policies replacing team-wide access |
| 0009 | Write-scope: `has_site_grant_at_least()` and write policies |
| 0010 | Vulnerability write policy tied to a permission |
| 0011 | `site_admin_users` table |
| 0012 | Revokes credential columns on `sites` from `authenticated` |
| 0013 | Drops admin users from snapshots |
| 0014 | `require_one_admin()` trigger on `user_roles` |
| 0015 | `jobs.dismissed_at` |
| 0016 | Index on `vuln_feed (updated_at desc)` |
| 0017 | Recorded site environment (production/staging) |
| 0018 | `jobs.cancelled_at`, `claim_jobs` skips cancelled |
| 0019 | Site origin IP/SNI override columns |
| 0020 | `sites.gsc_property`, `sites.ga4_property_id` |
| 0021 | `api_tokens` table for the MCP server |

## Where to change X

**Add a job type**
1. `src/services/jobs/types.ts`: add to `JobType`.
2. `src/services/jobs/handlers.ts`: add a key in `buildJobHandlers`.
3. Put the logic in `src/services/<domain>/`.
4. To schedule it, call `enqueueJob(..., { dedupe: true })` in `src/app/api/cron/enqueue/route.ts`.
5. No migration is needed, because `jobs.type` is plain text.

**Add an MCP tool**
1. Add `server.registerTool(...)` to the matching group in `src/mcp/tools/`. For a new group, create the file and add it to `GROUPS` in `src/mcp/server.ts`.
2. Widen the read-only dependency interface and `buildToolCtx` in `src/mcp/context.ts` if the tool needs new data access.
3. Inside the tool, apply `requirePermission`, `requireWritableToken` and `canAccessSite`. For destructive tools, spread `CONFIRM_SHAPE` from `src/mcp/confirm.ts`.
4. Test in `tests/mcp-tools-*.test.ts`. `tests/mcp-tools-structure.test.ts` pins the tool set.

**Add a permission**
1. `supabase/migrations/00NN_*.sql`: extend the `app_permission` enum and seed `role_permissions`. See `0006_rbac_schema.sql`.
2. `src/lib/authz/types.ts`: `APP_PERMISSIONS` and `DEFAULT_MATRIX`. `tests/authz-schema.test.ts` fails if these drift from the enum.
3. `src/lib/authz/token.ts`: classify it in `PERMISSION_KIND` (a missing entry fails `tsc`).
4. `src/app/(dashboard)/users/roles/matrix.tsx`: add its label and description.
5. Gate call sites with `can(viewer, ...)` or `checkPermission(...)`, and add RLS policies as in `0009_rbac_write_scope.sql`.

**Add a site tab**
1. `src/app/(dashboard)/sites/[id]/<tab>/page.tsx` (plus `loading.tsx`).
2. `src/app/(dashboard)/sites/[id]/tabs.tsx`: add an entry to `LIVE` with an icon from `src/components/ui/icons.tsx`.
3. `src/app/(dashboard)/sites/[id]/<tab>-actions.ts` for server actions, gated by `checkPermission`.
4. Add a service in `src/services/<tab>/` and, if it needs storage, a migration.

**Add a migration**
1. Create `supabase/migrations/00NN_<name>.sql` with the next number (currently 0022), written idempotently (`if not exists`).
2. Add or extend the repo in `src/services/<domain>/repo.ts` and its column list, for example `SITE_COLUMNS` in `src/services/sites/repo.ts`.
3. If the change touches RLS, extend `scripts/verify-rls.ts` and the `tests/authz-*.test.ts` checks.
4. Record deploy-order notes in `docs/ops/authorization.md` when the change is authorization-related.

## Docs

- `docs/ops/scheduling.md`: pg_cron + pg_net setup, why no Vercel crons
- `docs/ops/authorization.md`: migration ledger, role matrix, invites, lockout guards, `npm run verify:rls`
- `docs/ops/themes.md`: theme install, delete rules, bulk actions
- `docs/ops/geogrid.md`: providers (stub, n8n) and webhook contract
- `docs/ops/cloudflare.md`: Cloudflare and edge notes
- `docs/ops/local-verification.md`: running the panel locally
- `docs/ops/client-requests/README.md`: client-facing request documents
- Design spec: `docs/superpowers/specs/2026-08-27-wp-control-panel-design.md`
- MCP server: `docs/superpowers/specs/2026-09-12-panel-mcp-server-design.md`
- Authorization: `docs/superpowers/specs/2026-08-29-phase9a-authorization-design.md`
- Hardening: `docs/superpowers/specs/2026-09-12-automated-hardening-design.md`
- Design system: `DESIGN.md`
