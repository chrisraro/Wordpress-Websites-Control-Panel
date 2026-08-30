-- fix/critique-open-items: lets queued work be called off before it runs.
--
-- The critique's question was concrete: if a bulk action is queued against
-- the wrong site -- the exact scenario the environment work above exists to
-- prevent -- what can the operator do in the ninety seconds before the queue
-- drains? The answer was "watch". The batch page could only ever *accelerate*
-- the queue ("Process queue now"); nothing could stop it.
--
-- A column, not a new `job_status` value, and deliberately so. Postgres will
-- not let a value added by `alter type ... add value` be used elsewhere in
-- the same transaction, which makes an enum addition fragile to apply from a
-- SQL editor that wraps the script in one. `dismissed_at` (0015) set the
-- precedent for recording a job's disposition beside its status rather than
-- inside it, and it has the same virtue here: `status` and `last_error` stay
-- exactly as the worker left them, so a cancelled job is still fully
-- diagnosable rather than overwritten.
--
-- Cancellation is only ever honest about pending work. A job already claimed
-- and running is executing PHP on a live WordPress install; this cannot
-- reach into that, and the UI must not offer to. claim_jobs below therefore
-- refuses to pick up a cancelled row, and says nothing about rows already
-- claimed.
--
-- DEPLOY ORDER. Same shape as 0015: apply this BEFORE or WITH the deploy
-- that reads it. The jobs select on the batch page names `cancelled_at`, and
-- PostgREST rejects a select naming an unknown column, failing the whole
-- query. Old code against the new column is harmless. `if not exists` makes
-- this re-runnable.

set local search_path = public;

alter table jobs add column if not exists cancelled_at timestamptz;

-- Partial index: the queue only ever asks "is this row cancelled", never
-- "which rows are not", and the overwhelming majority are null.
create index if not exists jobs_cancelled_at_idx
  on jobs (cancelled_at) where cancelled_at is not null;

-- Republished with one added predicate. Everything else -- SKIP LOCKED for
-- concurrent processors, the attempts increment, the 15-minute stale-running
-- reclaim -- is unchanged from 0002_jobs_claim.sql.
--
-- The `cancelled_at is null` guard sits inside the inner select so a
-- cancelled row is never even locked, and it applies to the stale-reclaim
-- branch too: a job cancelled while it was running must not be resurrected
-- fifteen minutes later by the reclaim path. That is the subtle one, and it
-- is why the predicate is on the outer where of the subselect rather than
-- being tacked onto the pending branch alone.
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
    where cancelled_at is null
      and (
        (status = 'pending' and scheduled_for <= now())
        or (status = 'running' and started_at < now() - interval '15 minutes')
      )
    order by scheduled_for
    limit batch_size
    for update skip locked
  )
  returning *;
$$;

revoke execute on function claim_jobs(int) from public, anon, authenticated;
grant execute on function claim_jobs(int) to service_role;

comment on column jobs.cancelled_at is
  'Set when an operator calls off queued work before it runs. claim_jobs '
  'refuses to claim these. status and last_error are left untouched so the '
  'row stays diagnosable. Never set on a job already running -- cancellation '
  'cannot reach code executing on a live WordPress install.';
