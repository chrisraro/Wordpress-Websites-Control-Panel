-- Atomically claim up to batch_size due pending jobs.
-- SKIP LOCKED makes concurrent processors safe; attempts increments on claim.
create or replace function claim_jobs(batch_size int)
returns setof jobs
language sql
security definer
set search_path = public
as $$
  update jobs
  set status = 'running', started_at = now(), attempts = attempts + 1
  where id in (
    select id from jobs
    where status = 'pending' and scheduled_for <= now()
    order by scheduled_for
    limit batch_size
    for update skip locked
  )
  returning *;
$$;

revoke execute on function claim_jobs(int) from public, anon, authenticated;
grant execute on function claim_jobs(int) to service_role;
