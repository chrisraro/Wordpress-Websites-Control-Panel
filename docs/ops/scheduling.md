# Scheduling (pg_cron + pg_net)

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
