-- History retention (2026-09-29, owner-approved "Standard" windows).
--
-- uptime_checks gains a row per site every five minutes (~105k/site/year);
-- jobs, inventory snapshots and scan history grew without bound too. This
-- adds one function that trims them and schedules it nightly.
--
-- Windows:
--   uptime_checks     90 days
--   jobs              60 days after they finished (done/failed), and
--                     cancelled jobs 60 days after they were cancelled
--   site_snapshots    180 days
--   security_checks   365 days
--   seo_snapshots     365 days
--   activity_log      kept forever (audit trail)
--
-- The newest row per site is never deleted from site_snapshots or
-- security_checks, and the newest per site+source from seo_snapshots, however
-- old: a site that has not been scanned for a year must still show its last
-- known state rather than an empty page. Reports, GeoGrid history and
-- storage objects are not touched.
--
-- Re-runnable: `create or replace`, and the schedule is replaced by name.
-- Run by hand at any time: `select * from prune_history();`
-- Stop it: `select cron.unschedule('wp-panel-retention');`

set local search_path = public;

create or replace function prune_history()
returns table (table_name text, deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  delete from uptime_checks where checked_at < now() - interval '90 days';
  get diagnostics n = row_count; table_name := 'uptime_checks'; deleted := n; return next;

  delete from jobs
  where (status in ('done', 'failed') and finished_at < now() - interval '60 days')
     or (cancelled_at is not null and status = 'pending' and cancelled_at < now() - interval '60 days');
  get diagnostics n = row_count; table_name := 'jobs'; deleted := n; return next;

  delete from site_snapshots s
  where s.taken_at < now() - interval '180 days'
    and s.id <> (select l.id from site_snapshots l where l.site_id = s.site_id
                 order by l.taken_at desc limit 1);
  get diagnostics n = row_count; table_name := 'site_snapshots'; deleted := n; return next;

  delete from security_checks c
  where c.run_at < now() - interval '365 days'
    and c.run_at < (select max(l.run_at) from security_checks l where l.site_id = c.site_id);
  get diagnostics n = row_count; table_name := 'security_checks'; deleted := n; return next;

  delete from seo_snapshots p
  where p.taken_at < now() - interval '365 days'
    and p.taken_at < (select max(l.taken_at) from seo_snapshots l
                      where l.site_id = p.site_id and l.source = p.source);
  get diagnostics n = row_count; table_name := 'seo_snapshots'; deleted := n; return next;
end;
$$;

revoke execute on function prune_history() from public, anon, authenticated;
grant execute on function prune_history() to service_role;

-- Nightly at 03:17, after the 02:00 enqueue has fanned out. Only when
-- pg_cron is installed (it is on the hosted project; local test databases
-- may not have it).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'wp-panel-retention';
    perform cron.schedule('wp-panel-retention', '17 3 * * *', 'select * from public.prune_history()');
  end if;
end;
$$;
