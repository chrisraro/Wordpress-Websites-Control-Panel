# Scheduling (pg_cron + pg_net)

Vercel Hobby crons run at most once per day, so fine-grained schedules live in
Supabase. Run this ONCE in the Supabase SQL editor after deploying the app.
Replace `APP_URL` (your deployed origin, e.g. https://wp-panel.vercel.app) and
`CRON_SECRET` (same value as the Vercel env var).

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- process due jobs every minute
select cron.schedule('wp-panel-process', '* * * * *', $$
  select net.http_post(
    url := 'APP_URL/api/cron/process',
    headers := jsonb_build_object('x-cron-secret', 'CRON_SECRET')
  );
$$);

-- nightly snapshot fan-out at 02:00 UTC
select cron.schedule('wp-panel-enqueue', '0 2 * * *', $$
  select net.http_post(
    url := 'APP_URL/api/cron/enqueue',
    headers := jsonb_build_object('x-cron-secret', 'CRON_SECRET')
  );
$$);
```

Inspect: `select * from cron.job;` — Unschedule: `select cron.unschedule('wp-panel-process');`

Local dev has no scheduler: hit the routes manually, e.g.
`curl -H "x-cron-secret: <secret>" http://localhost:3000/api/cron/enqueue`
then `.../api/cron/process`.
