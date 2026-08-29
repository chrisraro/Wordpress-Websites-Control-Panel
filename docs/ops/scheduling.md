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
-- NOTE: refreshVulnFeed's freshness guard (src/services/security/scan.ts,
-- VULN_FEED_FRESH_MS) is hard-coded to 12h on the assumption this fires
-- once every 24h. Change this cadence to anything more frequent than every
-- 12h (e.g. '0 */6 * * *') and three of every four runs will silently skip
-- the Wordfence fetch instead of refreshing the feed. If you change this
-- schedule, update VULN_FEED_FRESH_MS to match.
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

Local dev has no scheduler: hit the routes manually, e.g.
`curl -H "x-cron-secret: <secret>" http://localhost:3000/api/cron/enqueue`
then `.../api/cron/process`.

Note: `/api/cron/process` declares `maxDuration = 300`, which needs Vercel Pro
(or Fluid Compute). On the Hobby plan the function is capped lower — jobs still
complete because each run claims at most 3 and unfinished jobs retry, but keep
individual site jobs fast.

## Why pg_cron only

`enqueueJob(..., { dedupe: true })` only suppresses a duplicate while an
identical job is still **pending** (see `JobsRepo.pendingExists`). It does
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
