-- claim_jobs hardening (2026-09-29 audit).
--
-- 1. The stale-running reclaim had no attempts cap. A job that is killed by
--    the platform (a handler longer than the route's 300s maxDuration, or an
--    out-of-memory on the vulnerability feed) never reaches the retry ladder,
--    because the ladder only runs when a handler throws. Reclaim therefore
--    re-ran it every 15 minutes forever, against a live client site each
--    time. Now a stale row is reclaimed only while it has attempts left, and
--    one that has spent them is failed with a diagnosable last_error.
--
-- 2. Nothing serialised work per site. With the processor firing every
--    minute and a handler taking minutes, two invocations could run two
--    upgrader passes on the same WordPress install at once (corrupting its
--    plugin directory), or grade a security scan against a half-refreshed
--    inventory. A pending job is no longer claimed while another job for the
--    same site is running (and not yet stale). Site-less jobs are unaffected.
--
-- Everything else is unchanged from 0018: SKIP LOCKED, the attempts
-- increment, the cancelled_at guard on both branches, ordering. The app now
-- claims one job at a time (processJobs), so batch_size is normally 1.
--
-- Safe to re-run: `create or replace` and an idempotent update.

set local search_path = public;

create or replace function claim_jobs(batch_size int)
returns setof jobs
language sql
security definer
set search_path = public
as $$
  -- A stuck row that has used its attempts is finished, not reclaimed.
  update jobs
  set status = 'failed', finished_at = now(),
      last_error = coalesce(last_error || ' | ', '')
        || 'stopped: still running after ' || attempts || ' attempts (worker killed or timed out)'
  where status = 'running'
    and started_at < now() - interval '15 minutes'
    and attempts >= 3
    and cancelled_at is null;

  update jobs
  set status = 'running', started_at = now(), attempts = attempts + 1
  where id in (
    select j.id from jobs j
    where j.cancelled_at is null
      and (
        (j.status = 'pending' and j.scheduled_for <= now()
          and (j.site_id is null or not exists (
            select 1 from jobs r
            where r.site_id = j.site_id
              and r.status = 'running'
              and r.started_at >= now() - interval '15 minutes'
          )))
        or (j.status = 'running' and j.started_at < now() - interval '15 minutes' and j.attempts < 3)
      )
    order by j.scheduled_for
    limit batch_size
    for update skip locked
  )
  returning *;
$$;

revoke execute on function claim_jobs(int) from public, anon, authenticated;
grant execute on function claim_jobs(int) to service_role;
