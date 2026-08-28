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

Set the same env vars in Vercel (including `CRON_SECRET`). `vercel.json`
registers a daily backstop cron; the real schedules run from Supabase —
see `docs/ops/scheduling.md` for the one-time pg_cron + pg_net setup.

## Background jobs

- Every 5 min: `/api/cron/uptime` checks HTTP + SSL expiry for all sites.
- Every minute: `/api/cron/process` claims up to 3 due jobs and runs them.
- Nightly: `/api/cron/enqueue` inserts `snapshot_refresh` per site, `security_scan`
  per site, and one `vuln_feed_refresh` (requires `WORDFENCE_API_KEY` — free key from
  wordfence.com/threat-intel; without it, vulnerability matching is skipped).
- Weekly per site: `seo_scan` (Rank Math audit, page scores, links, Search Console
  keywords, AI Visibility) plus PageSpeed Insights for mobile and desktop. Set
  `GOOGLE_PSI_API_KEY` (optional) to raise PageSpeed rate limits.
- Manual: every "Refresh inventory" button runs the same code path inline.

## Marketplace

`/marketplace` searches wordpress.org, installs plugins on one or many sites
(bulk installs run as a job batch with a live progress page), and accepts
uploaded plugin ZIPs (stored in the private `plugins` Supabase Storage bucket —
created by migration 0003). The Themes tab can generate a child theme of the
active theme.

## SEO & AEO

The SEO tab shows the Rank Math site-audit score with a trend sparkline, failing
audit findings with fix links, the lowest-scoring pages, Search Console keywords,
PageSpeed Insights scores, and the AI Visibility (AEO) brand panel. Sites without
Rank Math still get PageSpeed data — each source is collected independently, and a
source that is unavailable or fails is labelled on the page rather than failing
the scan.
