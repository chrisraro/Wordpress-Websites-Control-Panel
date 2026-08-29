-- Phase 9b, spec §5.1: WordPress administrator identities move out of
-- site_snapshots.payload into their own staff-only table.
--
-- A client granted a site reads that site's site_snapshots row through the
-- user-scoped client (0008_rls_scoped.sql's site_snapshots_read policy),
-- and payload.admin_users carries every WordPress administrator's login
-- and email. RLS is row-level and cannot filter inside a JSONB column, so
-- hiding the Administrators card in the UI is cosmetic, not access
-- control -- the row itself is still readable over PostgREST. The data has
-- to move to a table RLS can actually gate.
--
-- One row per site, replaced wholesale on each inventory refresh: the
-- history has no value and keeping it would only multiply the exposure
-- surface.
--
-- This migration has not been applied to any database, so it is written to
-- be re-run safely: `create table if not exists`, and `drop policy if
-- exists` before `create policy` -- the same re-run pattern
-- 0008_rls_scoped.sql uses for its policies (0008 creates no tables, so
-- `create table if not exists` is not its convention; every other table in
-- this repo uses a bare `create table`, and this one departs from that only
-- because this migration may need a second, harmless run).

set local search_path = public;

create table if not exists site_admin_users (
  site_id      uuid not null references sites(id) on delete cascade,
  collected_at timestamptz not null default now(),
  users        jsonb not null,
  primary key (site_id)
);

alter table site_admin_users enable row level security;

drop policy if exists site_admin_users_read on site_admin_users;

create policy site_admin_users_read on site_admin_users
  for select to authenticated
  using ( (select authorize('sites.view_all')) );

-- Old site_snapshots rows keep their admin_users key until this runs.
-- Without this line the fix is cosmetic for every site already scanned,
-- which is all of them: a client with a grant could still read the field
-- out of historical snapshot rows.
update site_snapshots set payload = payload - 'admin_users' where payload ? 'admin_users';

-- The database-level backstop for this split -- a check constraint on
-- site_snapshots forbidding an admin_users key -- is deliberately NOT in
-- this migration. It lives in 0013_snapshot_no_admin_users.sql, which must
-- be applied only after the code in this branch is deployed: the moment the
-- constraint exists, it rejects every snapshot write made by the
-- still-deployed old collectInventory, which still spreads admin_users into
-- the payload it stores. Applying it here, alongside the table and the
-- one-shot strip above (both of which are safe with old code running),
-- would break every refreshInventoryAction, every snapshot_refresh job, and
-- every security_scan that falls back to refreshSnapshot, from the moment
-- this migration lands until the new build goes live. See
-- 0013_snapshot_no_admin_users.sql for the rest of this reasoning.
