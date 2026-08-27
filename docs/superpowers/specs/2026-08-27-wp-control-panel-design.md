# WordPress Website Management Control Panel — Design

**Date:** 2026-08-27
**Status:** Approved pending user review
**Audience:** Internal OCS team only (invite-only accounts, no public signup)

## 1. Summary

A Next.js + Supabase web app that manages the team's client WordPress websites through each site's Novamira MCP endpoint (`https://<site>/wp-json/mcp/novamira`, WordPress Application Password auth). It provides WP Toolkit–style management, security analytics, SEO/AEO page insights, PDF report generation with shareable links, a plugin marketplace (search, install, upload, bulk install), child theme installation, and GeoGrid local-rank tracking (provider stubbed for now).

## 2. Decisions Locked During Brainstorming

| Decision | Choice |
|---|---|
| Audience | Internal team only — simple auth, no multi-tenancy |
| Architecture | Vercel-native Next.js monolith (Approach A) |
| GeoGrid data provider | Provider-agnostic adapter; ship with deterministic stub + **n8n webhook provider** (user runs n8n and will orchestrate rank lookups there); DataForSEO-shaped direct adapter possible later |
| Security scope | Vulnerability matching + hardening audit + uptime/SSL + core checksum integrity (all four) |
| Hosting | Vercel; Supabase for data/auth/storage |
| Reports | Branded PDF + shareable public link, stored in Supabase Storage |

## 3. Tech Stack

- **Framework:** Next.js 15+ (App Router, TypeScript, React Server Components), deployed on Vercel
- **Backend data:** Supabase — Postgres, Auth (email/password, invite-only), Storage (plugin ZIPs, report PDFs)
- **MCP client:** `@modelcontextprotocol/sdk` v1.x, server-side only. `StreamableHTTPClientTransport` with `requestInit.headers` carrying `Authorization: Basic <base64(user:appPassword)>`. Client created and closed per request/job (serverless-safe; no pooling). Known SDK caveat: some builds dropped `requestInit` headers — pin the version and verify headers reach the site on first connect.
- **UI:** Tailwind CSS + shadcn/ui; Recharts for charts; Leaflet for the GeoGrid map
- **PDF:** `@react-pdf/renderer` (~2MB bundle, fast, serverless-safe). Charts rendered to SVG/PNG server-side and embedded.
- **Scheduling:** Supabase `pg_cron` + `pg_net` fires HTTP POSTs (with a shared `CRON_SECRET` header) at Vercel API routes. Rationale: Vercel Hobby crons run at most once/day; pg_cron gives per-minute granularity for free. Vercel Cron kept only as a once-daily backstop for the nightly enqueue.
- **External services:**
  - **Vulnerabilities:** Wordfence Intelligence vulnerability feed (free; register account/API key per v3 requirements effective March 2026). Feed is pulled nightly by one job, diffed into Supabase; all site matching is done locally against the cached table — zero per-site API calls. Patchstack public database as manual cross-reference.
  - **Page performance:** Google PageSpeed Insights API v5 (free key; 25k queries/day). Treat CrUX fields as optional — Google is deprecating their inclusion.
  - **Marketplace:** WordPress.org APIs — `https://api.wordpress.org/plugins/info/1.2/` (`query_plugins` search/browse-popular, `plugin_information` detail) and `themes/info/1.2/` equivalent. No key; cache responses.
  - **GeoGrid:** primary provider is the team's **n8n instance** via webhook (see 6.7) — n8n owns the actual rank-lookup orchestration (whatever nodes/APIs it uses are invisible to this app). A direct DataForSEO adapter (`location_coordinate: "lat,lng,zoom"`, ~$0.60/1k queued SERPs) remains possible later behind the same interface.

### 3.1 Amendment (2026-08-28): execute-php instead of WP-CLI

Live testing showed WP-CLI is broken host-wide on the team's hosting (the `wp`
binary runs under a `cgi-fcgi` PHP SAPI and refuses to execute, exit 255, on
every site). **All WordPress operations therefore run via `novamira/execute-php`**
— generated PHP snippets executed inside WordPress (`src/lib/wpphp.ts`:
`runPhp`, base64-safe value embedding). Verified live: WP_Filesystem resolves
`direct`, so Plugin/Theme/Core upgraders work headlessly. Consequences:
- Inventory = one PHP round trip (transient refresh + get_plugins/wp_get_themes/get_users).
- Manage actions = upgrader classes / activate_plugin / .maintenance file / wp_cache_flush / flush_rewrite_rules.
- Any spec mention of WP-CLI commands (e.g. `wp core verify-checksums` in §6.2)
  is implemented in PHP instead — checksums via the wordpress.org checksums API
  (`https://api.wordpress.org/core/checksums/1.0/`) fetched server-side with
  `wp_remote_get` + `md5_file` comparison.
- The `mcp-adapter-execute-ability` response wraps ability output in a
  `{success, data}` envelope — always unwrap (`src/lib/mcp/envelope.ts`).
- Phase 4 amendment: uploaded-plugin installs do NOT use `novamira/create-upload-link`.
  ZIPs live in the private `plugins` Supabase Storage bucket; the job handler signs a
  1h download URL at run time and `Plugin_Upgrader->install($url)` fetches it — one
  uniform install path for wp.org and uploads. Already-installed wp.org plugins
  short-circuit to success (activate if requested); uploads install with
  `overwrite_package => true` (deliberate reinstall semantics).

## 4. Architecture

```
Browser (team, auth-gated)
   │
Next.js on Vercel
   ├─ Server Components / route handlers ── read ──► Supabase Postgres (snapshots, findings, jobs)
   ├─ Server actions (mutations) ── MCP client ──► per-site /wp-json/mcp/novamira
   ├─ /api/cron/* routes ◄── pg_cron + pg_net (uptime */5, process */1, enqueue nightly)
   ├─ /api/webhooks/n8n/geogrid ◄── n8n instance (HMAC-signed rank results)
  └─ /r/[token] public report pages ──► Supabase Storage (PDFs)
```

Principles:

- **All WordPress calls are server-side.** No MCP endpoint, credential, or raw MCP response ever reaches the browser.
- **Analytics pages read from Supabase snapshots**, never live MCP — fast loads and historical trends. Live MCP is used only for on-demand actions (install, update, "refresh now").
- **One job queue** (`jobs` table) serves both scheduled and manual work — a single code path.
- **Capability-aware degradation:** on connect, each site's `discover-abilities` result is stored as a capability map; features a site lacks (e.g. Rank Math abilities) are hidden for that site rather than erroring.

### Module layout

```
src/
  lib/mcp/            # MCP client factory, typed error mapping, ability helpers
  lib/crypto/         # app-password encryption (libsodium sealed box, key in env)
  lib/adapters/       # vulnfeed/ (wordfence), psi/, wporg/, geogrid/ (interface + stub + n8n webhook)
  services/           # one file per domain: sites, inventory, security, uptime,
                      # seo, marketplace, childtheme, geogrid, reports, jobs
  app/(dashboard)/    # auth-gated UI routes
  app/api/cron/       # uptime, enqueue, process (CRON_SECRET-protected)
  app/r/[token]/      # public report share pages
```

Services contain all business logic and are unit-testable with a `MockMcpClient`; route handlers and server actions stay thin.

## 5. Data Model (Supabase)

- `sites` — id, name, url, mcp_endpoint, wp_username, app_password_encrypted, status (`connected | degraded | reconnect_needed | disabled`), client_label, capability map (JSONB), created_by
- `site_snapshots` — site_id, taken_at, payload JSONB (WP/PHP versions, plugins[name, version, active], themes, counts). Latest row powers the toolkit grid; history powers trends.
- `vuln_feed` — cached Wordfence feed entries: software slug/type, affected version range, CVE, CVSS, fixed_in, updated_at
- `site_vulnerabilities` — site_id ↔ matched feed entry, component, installed_version, severity, status (`open | fixed | ignored`)
- `security_checks` — site_id, run_at, check_id, result (`pass | fail | warn`), details JSONB
- `uptime_checks` — site_id, checked_at, http_status, response_ms, ssl_days_remaining, ok
- `seo_snapshots` — site_id, taken_at, source (`rankmath_audit | rankmath_scores | links | keywords | ai_visibility | psi`), payload JSONB
- `geogrid_configs` — site_id, business name/place ref, keywords[], grid_size (3–9 odd), spacing_m, center lat/lng, provider
- `geogrid_snapshots` — config_id, run_at, keyword, points JSONB [{lat, lng, rank}]
- `reports` — site_id, generated_at, sections[], period, storage_path, share_token (128-bit, revocable), auto (bool)
- `jobs` — id, type, site_id, batch_id, payload JSONB, status (`pending | running | awaiting_callback | done | failed`), attempts, max 3, scheduled_for, started_at, finished_at, last_error
- `activity_log` — actor (auth uid), site_id, action, detail JSONB, at

**RLS:** every table `authenticated`-only (plus service-role for cron); `reports` share pages resolve tokens via a security-definer RPC, not direct table access. **Secrets:** app passwords encrypted with a libsodium key held only in Vercel env vars.

## 6. Feature Modules

### 6.1 Site connection & WP Toolkit
Add-site flow: URL + WP username + Application Password → test MCP handshake → run `discover-abilities` → store capability map + encrypted credentials. Dashboard home: site cards (WP/PHP version, pending updates, security grade, SEO score, uptime dot). Site detail tabs: Overview, Plugins, Themes, Security, SEO, GeoGrid, Reports. Actions via MCP `run-wp-cli`: core/plugin/theme update (single + bulk), activate/deactivate, cache flush, maintenance mode, permalink flush, list admin users. Every mutation → `activity_log` + confirm dialog.

### 6.2 Security analytics
Nightly per-site job: (a) inventory refresh → local match against `vuln_feed`; (b) hardening audit — ~15 fixed checks (WP_DEBUG, file editor, SSL, `admin` username, table prefix, directory listing, xmlrpc, user enumeration, salts, inactive plugins, outdated PHP, etc.) executed as **one** `execute-php` call returning JSON; (c) `wp core verify-checksums` via WP-CLI. Uptime + SSL: every 5 min, plain HTTPS request + TLS cert inspection from the uptime cron route (no MCP). Grade A–F computed from weighted findings; findings list offers MCP-powered one-click fixes where safe (disable file editor, deactivate vulnerable plugin).

### 6.3 SEO/AEO insights
Weekly + on-demand job per site (capability-gated on Rank Math abilities): `audit-site-seo`, `get-seo-scores`, `get-link-report`, `get-top-keywords` (GSC), `get-ai-visibility-overview` / `brand-insights` (AEO). Plus PSI v5 (mobile + desktop) for homepage and configured key pages. UI: score trend charts, failing tests with fix hints and one-click `fix-site-seo` where supported, keyword table, AEO panel (AI-visibility score, rank, sentiment, per-model citations).

### 6.4 Reports
Site + sections (security/SEO/AEO/geogrid) + period → server action renders `@react-pdf/renderer` document from stored snapshots → upload to Storage → `reports` row with share token → `/r/[token]` public page (summary + PDF download). Optional monthly auto-generation per site (job type `report_generate`). Tokens revocable from UI.

### 6.5 Plugin marketplace & bulk ops
Search/browse wp.org (popular, ratings, active installs, icons; cached). Install+activate on one site (`wp plugin install <slug> --activate`) or bulk: select sites → one job per site under a shared `batch_id` → UI polls batch progress per site. Upload custom/premium plugin: ZIP → Supabase Storage → per target site: MCP `create-upload-link` → server streams ZIP to the returned endpoint → `wp plugin install <uploaded-file> --activate`. Same path reused for bulk upload-installs.

### 6.6 Child theme installer
Detect active theme → generate child theme (style.css header + functions.php enqueue) via MCP `write-file` into `wp-content/themes/<slug>-child` → optional activate via WP-CLI. Guardrails: refuse if active theme is already a child theme; never overwrite an existing directory.

### 6.7 GeoGrid (n8n-powered)
Config per site: business, keywords, odd N×N grid (3–9), spacing (meters), center. Run: enqueue one job per keyword.

**Provider adapter interface** (all providers implement it):
- Synchronous shape: `getLocalRanks(keyword, points[], businessRef) → ranks[]` — used by `StubProvider` (deterministic pseudo-random ranks seeded from input; default in dev/tests) and a possible future `DataForSeoProvider`.
- Asynchronous shape (primary, production): **`N8nWebhookProvider`** —
  1. The job POSTs to the configured n8n webhook URL (`N8N_GEOGRID_WEBHOOK_URL`, secret header `N8N_WEBHOOK_SECRET`) a payload: `{ run_id, keyword, business: {name, place_ref}, points: [{idx, lat, lng}], callback_url }`.
  2. The job moves to status `awaiting_callback` (no compute held open on Vercel).
  3. n8n orchestrates the rank lookups however the team designs the workflow (its nodes, APIs, or scraping are outside this app's concern) and POSTs results to `/api/webhooks/n8n/geogrid` — `{ run_id, ranks: [{idx, rank|null}] }` — authenticated by an HMAC signature over the body using `N8N_WEBHOOK_SECRET`.
  4. The callback route validates run_id + signature, writes the `geogrid_snapshots` row, and marks the job `done`. Partial results are accepted (missing points stored as null/absent).
  5. A watchdog in `/api/cron/process` fails any `awaiting_callback` job older than 30 min (retry per normal backoff, max 3).

Provider selection is per `geogrid_configs.provider` (`stub | n8n`), so sites can be tested with the stub while others use n8n.

**Building the n8n workflow:** the team already runs n8n with its connector wired to Claude Desktop. When Phase 6 starts, the workflow (webhook trigger → rank lookups → HMAC-signed callback POST) will be created via the n8n MCP connector added to this Claude Code session, or via n8n's REST API (instance URL + API key) — whichever the team provides. This repo only owns the webhook/callback contract defined above.

UI: Leaflet map, colored rank pins (1–3 green … 20+/absent red), keyword switcher, run-history comparison with rank deltas, and a run-status indicator (queued → sent to n8n → results received).

## 7. Job System & Scheduling

- `pg_cron` + `pg_net` schedules (all POST with `CRON_SECRET` header):
  - `*/5 * * * *` → `/api/cron/uptime` — checks all sites inline (HTTP + TLS only, fast)
  - `* * * * *` → `/api/cron/process` — claims up to N pending jobs via `FOR UPDATE SKIP LOCKED`, runs each within a per-job time budget
  - nightly → `/api/cron/enqueue` — inserts `security_scan`, `snapshot_refresh`, weekly `seo_scan`, monthly `report_generate`, nightly `vuln_feed_refresh` (one global job)
- Jobs idempotent; `attempts` max 3 with exponential backoff; `last_error` recorded. Manual "Refresh now" buttons enqueue identical job types.
- Bulk installs = N jobs + `batch_id`; UI polls batch status.

## 8. Error Handling & Resilience

- Typed MCP error mapping: unreachable / auth rejected (→ site `reconnect_needed` + UI banner) / ability missing (→ feature hidden) / WP-CLI nonzero exit (→ surfaced with stderr).
- 30s MCP call timeout; client always closed in `finally`.
- 3 consecutive failed scans → site `degraded`, banner instead of silently stale data.
- Destructive actions: confirm dialog + activity log, always.
- Cron routes reject requests without `CRON_SECRET`; the n8n callback route rejects payloads without a valid HMAC signature or with an unknown/expired `run_id`.
- `awaiting_callback` jobs older than 30 min are failed by the processor watchdog and retried per normal backoff.

## 9. Testing

- **Vitest** unit tests: vuln version-range matching, security grading, geogrid grid math + stub provider determinism, n8n callback HMAC validation + payload handling, job claim/backoff logic, child-theme file generation.
- **`MockMcpClient`** fixture: services tested without real sites.
- **Playwright** smoke: login, add site (against mock), dashboard render, report share page.

## 10. Build Phases

1. **Foundation** — scaffold, Supabase schema + auth + RLS, add-site flow, MCP client layer, dashboard grid + site overview
2. **WP Toolkit** — snapshots, update/activate actions, activity log, jobs system + pg_cron wiring
3. **Security** — Wordfence feed ingestion, matching, hardening audit, checksums, uptime/SSL, grading UI
4. **Marketplace** — wp.org search, install/activate, plugin upload, bulk installs, child theme installer
5. **SEO/AEO** — Rank Math + PSI ingestion, trends UI, AI Visibility panel
6. **GeoGrid** — configs, provider interface, stub provider, n8n webhook provider + HMAC callback route, Leaflet map UI, run history
7. **Reports** — PDF pipeline, share links, monthly auto-reports

Each phase ships something usable on its own. Phases 3–7 each get their own implementation plan derived from this spec.

## 11. Out of Scope (YAGNI)

- Client logins / multi-tenancy, billing, public signup
- Direct GeoGrid API integrations (DataForSEO/SerpApi) — n8n owns rank lookups for v1; the n8n workflow itself is built in n8n, not in this repo (this app only defines the webhook/callback contract)
- Backup management, staging clones, DNS/domain management
- White-label theming of the panel itself
- Email/Slack alerting (log + UI banners only for v1)
