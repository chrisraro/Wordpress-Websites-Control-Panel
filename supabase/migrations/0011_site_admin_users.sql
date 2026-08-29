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
-- This migration has not been applied to any database, so, following
-- 0008_rls_scoped.sql's convention, it is written to be re-run safely:
-- `create table if not exists`, `drop policy if exists` before
-- `create policy`, and the new constraint is dropped and re-added rather
-- than left to fail a second run.

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

-- Backstop the invariant the strip above only enforces once: the strip is a
-- one-shot `update`, and after this migration the only thing keeping
-- admin_users out of newly-inserted payloads is a destructuring expression
-- in collectInventory (src/services/inventory/service.ts). A revert of that
-- application code, or a later "simplification" back to spreading the raw
-- MCP response, would silently re-publish admin logins to every client with
-- a grant, with nothing failing -- unless the database itself refuses the
-- row.
alter table site_snapshots
  drop constraint if exists site_snapshots_no_admin_users;

alter table site_snapshots
  add constraint site_snapshots_no_admin_users
  check (not (payload ? 'admin_users'));
