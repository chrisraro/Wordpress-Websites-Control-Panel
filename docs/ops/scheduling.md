# Scheduling (pg_cron + pg_net)

**pg_cron is the only scheduler for this app.** `vercel.json` must not
declare a `crons` entry for `/api/cron/enqueue` (or any of the three routes
below) — see "Why pg_cron only", below, before adding one back.

Vercel Hobby crons run at most once per day, so fine-grained schedules live in
Supabase. Run this ONCE in the Supabase SQL editor after deploying the app.
Replace `APP_URL` (your deployed origin, e.g. https://wp-panel.vercel.app) and
`CRON_SECRET` (same value as the Vercel env var).

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- process due jobs every minute
-- (timeout raised above pg_net's 5s default: the route may run for minutes;
--  pg_net only tracks the request, the route keeps running server-side anyway)
select cron.schedule('wp-panel-process', '* * * * *', $$
  select net.http_post(
    url := 'APP_URL/api/cron/process',
    headers := jsonb_build_object('x-cron-secret', 'CRON_SECRET'),
    timeout_milliseconds := 300000
  );
$$);

-- nightly snapshot fan-out at 02:00 UTC
--
-- NOTE: refreshVulnFeed no longer has a freshness guard, so this cadence is
-- free to change without a matching constant to update. The guard used to
-- skip the fetch when the newest feed row was under 12h old, which tested
-- whether some rows were recent rather than whether the feed was complete --
-- a run that died on chunk 8 of 87 left 4,000 of 43,060 rows with a fresh
-- timestamp, and the next job skipped and reported success in 0.4s. Duplicate
-- work from a same-night double-trigger is prevented at enqueue instead
-- (dedupe: true in api/cron/enqueue) plus the one-scheduler rule above.
select cron.schedule('wp-panel-enqueue', '0 2 * * *', $$
  select net.http_post(
    url := 'APP_URL/api/cron/enqueue',
    headers := jsonb_build_object('x-cron-secret', 'CRON_SECRET')
  );
$$);

-- uptime + SSL checks every 5 minutes
select cron.schedule('wp-panel-uptime', '*/5 * * * *', $$
  select net.http_post(
    url := 'APP_URL/api/cron/uptime',
    headers := jsonb_build_object('x-cron-secret', 'CRON_SECRET'),
    timeout_milliseconds := 60000
  );
$$);
```

The nightly enqueue also queues one `seo_scan` per site whose last SEO run is
older than 7 days, so SEO data refreshes weekly without a separate schedule.

Inspect: `select * from cron.job;` — Unschedule: `select cron.unschedule('wp-panel-process');`

**Retention** (`wp-panel-retention`, 03:17 nightly) is scheduled by migration
0025 itself — it calls a database function, not the app, so it needs no URL or
secret. It deletes uptime checks older than 90 days, finished or cancelled jobs
older than 60 days, inventory snapshots older than 180 days, and security/SEO
history older than a year, always keeping the newest row per site (and per SEO
source). The activity log, reports and GeoGrid history are kept. Run it by hand
with `select * from prune_history();`; stop it with
`select cron.unschedule('wp-panel-retention');`.

Local dev has no scheduler: hit the routes manually, e.g.
`curl -H "x-cron-secret: <secret>" http://localhost:3000/api/cron/enqueue`
then `.../api/cron/process`.

Note: `/api/cron/process` declares `maxDuration = 300`, which needs Vercel Pro
(or Fluid Compute). On the Hobby plan the function is capped lower. Each run
claims one job at a time, up to 3, and stops claiming after 120s so it never
claims work it cannot finish. A job whose worker is killed stays `running`;
after 15 minutes `claim_jobs` reclaims it while it has attempts left and fails
it after the third (migration 0022). Keep individual site jobs fast. Jobs for
one site never run concurrently: a pending job waits while another job for the
same site is running.

## Why pg_cron only

`enqueueJob(..., { dedupe: true })` only suppresses a duplicate while an
identical job is still queued or in flight (pending, running or awaiting a
callback, and not cancelled — see `JobsRepo.pendingExists`). It does
not — and cannot, without a much bigger change — know that a job it enqueued
an hour ago already ran to completion. A second scheduler hitting
`/api/cron/enqueue` after the first batch has finished re-enqueues the whole
nightly fan-out: `vuln_feed_refresh` again, and `snapshot_refresh` +
`security_scan` for every active site again, meaning every client's
production WordPress gets hit by the toolkit twice in one night instead of
once. This is exactly what happened when `vercel.json` also scheduled
`/api/cron/enqueue` at 03:00 alongside pg_cron's `wp-panel-enqueue` at 02:00.

pg_cron has to be the one scheduler that survives, because it already owns
`wp-panel-process` (every minute) and `wp-panel-uptime` (every five minutes)
above — schedules Vercel's own cron cannot express on all plans (Hobby cron
runs at most once a day). Consolidating everything onto pg_cron means one
scheduler to reason about instead of two that can silently overlap.

**If you are tempted to add a Vercel cron for `/api/cron/enqueue` "for
reliability" or "as a backup"**: don't. `enqueueJob`'s dedupe guard will not
save you — by the time a second trigger fires, the first run's jobs are no
longer pending, so nothing suppresses the duplicate. The result is silent:
no error, no alert, just every site's nightly snapshot and security scan
running twice, and the Wordfence-backed vuln feed refresh burning through its
rate limit on a duplicate request it didn't need. If you need "reliability",
add monitoring on `cron.job_run_details` in Supabase, or a health check that
alerts when `wp-panel-enqueue` hasn't fired — not a second scheduler hitting
the same endpoint.

## Maintenance windows (per-site `scheduled_for`)

Each site may carry a weekly maintenance window
(`0027_site_maintenance_window.sql`: weekdays, local start time, duration,
IANA zone, default `Asia/Manila`), edited in the Connection card on the site
page by staff with `sites.manage` and a `manage` grant.

The dashboard's "Update plugins on N sites" and "Harden N sites", and the
bulk **Update** on a site's Plugins and Themes tabs, ask "Run now" or "In each
site's maintenance window" when at least one target site has a window. The
second choice sets each job's `scheduled_for` to that site's next window start
(`nextWindowStart` in `src/services/maintenance/window.ts`); a site without a
window, or whose window is open right now, runs now. No new scheduler is
involved: the per-minute `/api/cron/process` drain already skips jobs whose
`scheduled_for` is in the future (`claim_jobs`, `0022`). The batch page shows
those jobs as pending until then; cancelling the batch calls them off.

The MCP `update_all_plugins_fleet` tool still always runs now.
