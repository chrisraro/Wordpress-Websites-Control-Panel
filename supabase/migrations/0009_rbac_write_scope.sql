-- Phase 9a follow-up: closes a hole in 0008_rls_scoped.sql's child-table
-- write policies. Migrations 0006, 0007 and 0008 are already applied to the
-- live database, so this corrects them forward rather than editing their
-- SQL in place.
--
-- What 0008 got wrong, and why: its comment above the child-table policies
-- claims "writes require the stricter 'manage' level". That was true of the
-- intent, not the result. Every one of those `_write` policies is built on
-- `has_site_access(site_id, 'manage')` alone, and `has_site_access()`
-- (0007_rbac_functions.sql) opens with
--   (select public.authorize('sites.view_all')) or exists (...)
-- which short-circuits the whole function to `true` for anyone holding
-- `sites.view_all` -- regardless of `p_min_level`. `sites.view_all` is a
-- READ-scope permission (docs/ops/authorization.md) that `content_writer`
-- holds. So a `content_writer`, who holds none of `wp_toolkit.manage`,
-- `security.run`, `reports.manage` etc., could use their own session JWT
-- and the public anon key to write every one of these eight tables over
-- PostgREST -- e.g. `PATCH /rest/v1/reports?id=eq.<any>` to null out a
-- `share_token` (the exact action `reports.manage` gates), or
-- `DELETE /rest/v1/security_checks?site_id=eq.<any>` to wipe scan history.
--
-- `has_site_access()` itself is NOT changed here -- other policies (the
-- eight `_read` policies, `sites_select_scoped`) depend on its current
-- "sites.view_all sees everything" behaviour, which is correct for reads.
-- The bug is specific to write policies leaning on it for a 'manage'
-- distinction it cannot deliver. Fixed instead by a new helper, below,
-- that does not consult `sites.view_all` at all, plus a real permission
-- check alongside it.

set local search_path = public;

-- has_site_grant_at_least: unlike has_site_access(), this never consults
-- sites.view_all -- it answers only "does this user hold an actual grant
-- row on this site at least this strong", so it cannot be short-circuited
-- by a read-scope staff permission. Used only by the write policies below,
-- always alongside a real authorize() check for the permission that
-- governs the data.
create or replace function public.has_site_grant_at_least(
  p_site_id uuid,
  p_min_level public.site_access_level
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_site_access
    where user_id = (select auth.uid())
      and site_id = p_site_id
      and (access_level = 'manage' or p_min_level = 'read')
  );
$$;

grant execute on function public.has_site_grant_at_least(uuid, public.site_access_level) to authenticated;

-- ---------------------------------------------------------------------
-- Eight child-table write policies, replaced to require BOTH a real
-- manage-level grant on the site (has_site_grant_at_least) AND the
-- permission that governs that table's data (authorize(...)). Read
-- policies are untouched -- has_site_access(site_id) at the default
-- 'read' level, including its sites.view_all short-circuit, is correct
-- for reads and stays exactly as 0008 wrote it.
--
-- Consequence, and it is intended: staff holding sites.view_all but no
-- per-site *grant* row can no longer write these tables over PostgREST.
-- That is fine because the application never writes them through the
-- anon/user-scoped client -- every legitimate write (scans, snapshots,
-- geogrid runs, report generation/revocation) goes through
-- src/lib/supabase/server.ts's service-role client, which carries
-- bypassrls and ignores RLS entirely. These policies exist only as the
-- backstop for a missed application-level check and for anyone hitting
-- PostgREST directly with a session JWT.
-- ---------------------------------------------------------------------

drop policy if exists site_snapshots_write on site_snapshots;
create policy site_snapshots_write on site_snapshots
  for all to authenticated
  using ( (select authorize('wp_toolkit.manage')) and (select has_site_grant_at_least(site_id, 'manage')) )
  with check ( (select authorize('wp_toolkit.manage')) and (select has_site_grant_at_least(site_id, 'manage')) );

drop policy if exists site_vulnerabilities_write on site_vulnerabilities;
create policy site_vulnerabilities_write on site_vulnerabilities
  for all to authenticated
  using ( (select authorize('wp_toolkit.manage')) and (select has_site_grant_at_least(site_id, 'manage')) )
  with check ( (select authorize('wp_toolkit.manage')) and (select has_site_grant_at_least(site_id, 'manage')) );

drop policy if exists security_checks_write on security_checks;
create policy security_checks_write on security_checks
  for all to authenticated
  using ( (select authorize('security.run')) and (select has_site_grant_at_least(site_id, 'manage')) )
  with check ( (select authorize('security.run')) and (select has_site_grant_at_least(site_id, 'manage')) );

drop policy if exists uptime_checks_write on uptime_checks;
create policy uptime_checks_write on uptime_checks
  for all to authenticated
  using ( (select authorize('security.run')) and (select has_site_grant_at_least(site_id, 'manage')) )
  with check ( (select authorize('security.run')) and (select has_site_grant_at_least(site_id, 'manage')) );

drop policy if exists seo_snapshots_write on seo_snapshots;
create policy seo_snapshots_write on seo_snapshots
  for all to authenticated
  using ( (select authorize('seo.run')) and (select has_site_grant_at_least(site_id, 'manage')) )
  with check ( (select authorize('seo.run')) and (select has_site_grant_at_least(site_id, 'manage')) );

drop policy if exists geogrid_configs_write on geogrid_configs;
create policy geogrid_configs_write on geogrid_configs
  for all to authenticated
  using ( (select authorize('geogrid.manage')) and (select has_site_grant_at_least(site_id, 'manage')) )
  with check ( (select authorize('geogrid.manage')) and (select has_site_grant_at_least(site_id, 'manage')) );

-- geogrid_snapshots has no site_id of its own -- it scopes through its
-- config_id join to geogrid_configs, same shape 0008 used for its read
-- policy. Keep the join; add the same two-part condition through it.
drop policy if exists geogrid_snapshots_write on geogrid_snapshots;
create policy geogrid_snapshots_write on geogrid_snapshots
  for all to authenticated
  using (
    (select authorize('geogrid.manage'))
    and (select has_site_grant_at_least(geogrid_configs.site_id, 'manage')
           from geogrid_configs
          where geogrid_configs.id = geogrid_snapshots.config_id)
  )
  with check (
    (select authorize('geogrid.manage'))
    and (select has_site_grant_at_least(geogrid_configs.site_id, 'manage')
           from geogrid_configs
          where geogrid_configs.id = geogrid_snapshots.config_id)
  );

drop policy if exists reports_write on reports;
create policy reports_write on reports
  for all to authenticated
  using ( (select authorize('reports.manage')) and (select has_site_grant_at_least(site_id, 'manage')) )
  with check ( (select authorize('reports.manage')) and (select has_site_grant_at_least(site_id, 'manage')) );

-- ---------------------------------------------------------------------
-- sites: client credential columns. RLS is row-level -- it cannot stop a
-- client who is granted a site from selecting columns the UI simply
-- chooses not to render. Spec section 5 ("What a client sees") hides
-- mcp_endpoint and wp_username on the site overview specifically because
-- they are credentials-adjacent and disclose the integration's shape; a
-- client with a granted site could otherwise run
-- `GET /rest/v1/sites?select=mcp_endpoint,wp_username,app_password_encrypted`
-- directly against PostgREST and read them regardless of what the page
-- renders.
--
-- NOT applied in this migration. Verification (src/lib/authz/db.ts,
-- src/services/sites/repo.ts) found that readDbFor() hands every
-- `client`-role page -- /dashboard and /sites/[id] and all six of its
-- tabs -- the user-scoped client, and supabaseSitesRepo's SITE_COLUMNS
-- constant unconditionally selects mcp_endpoint and wp_username as part
-- of the same query that renders those pages. A column-level revoke
-- fails a select naming a revoked column outright (PostgREST surfaces
-- Postgres's "permission denied for column" as an error for the whole
-- request, not a silently omitted field), so revoking those columns from
-- `authenticated` here would break every one of those pages for every
-- client-role user, not just hide two fields. That regression is not
-- something this migration should ship silently, so the revoke is left
-- undone -- see the "Known exposures" write-up this same change adds to
-- docs/ops/authorization.md, and the accompanying report, for what a real
-- fix requires (SITE_COLUMNS would need a client-safe projection distinct
-- from the staff one, landing in the same change as the revoke).
