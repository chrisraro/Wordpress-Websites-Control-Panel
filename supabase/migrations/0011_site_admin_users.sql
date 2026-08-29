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

set local search_path = public;

create table site_admin_users (
  site_id      uuid not null references sites(id) on delete cascade,
  collected_at timestamptz not null default now(),
  users        jsonb not null,
  primary key (site_id)
);

alter table site_admin_users enable row level security;

create policy site_admin_users_read on site_admin_users
  for select to authenticated
  using ( (select authorize('sites.view_all')) );

-- Old site_snapshots rows keep their admin_users key until this runs.
-- Without this line the fix is cosmetic for every site already scanned,
-- which is all of them: a client with a grant could still read the field
-- out of historical snapshot rows.
update site_snapshots set payload = payload - 'admin_users' where payload ? 'admin_users';
