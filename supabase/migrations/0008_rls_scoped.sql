-- Phase 9a: scoped RLS. Replaces the blanket team_all policy (0001_init.sql)
-- on the 12 original tables with policies scoped by site access or a
-- staff-only permission, per design doc section 6, and adds the first
-- policies for the four RBAC tables (0006_rbac_schema.sql), which have
-- carried RLS-enabled/zero-policies (default-deny) until now.
--
-- Nothing behavioural changes today: every server-side code path uses the
-- service-role client, which carries bypassrls and ignores every policy
-- below. This migration exists so a future user-scoped client read path is
-- a real, database-enforced boundary, and as the backstop for a missed
-- application-level check.
--
-- House rules followed throughout:
--   * every policy names "to authenticated" -- a policy with no role clause
--     also evaluates for anon, which is both a security smell and a
--     per-row cost.
--   * every call to the authorize / has_site_access helpers is wrapped as
--     "(select ...)" so Postgres evaluates it once per statement via an
--     InitPlan instead of once per row.
--   * no policy calls a helper that reads the table the policy protects --
--     see user_site_access's self-read policy below for the one case this
--     project would otherwise hit.

-- ---------------------------------------------------------------------
-- sites: read scoped by grant, write gated by the staff-only permission.
-- ---------------------------------------------------------------------
drop policy team_all on sites;

create policy sites_select_scoped on sites
  for select to authenticated
  using ( (select has_site_access(id)) );

create policy sites_write on sites
  for all to authenticated
  using ( (select authorize('sites.manage')) )
  with check ( (select authorize('sites.manage')) );

-- ---------------------------------------------------------------------
-- Child tables: every row belongs to a site (or, for geogrid_snapshots,
-- to a geogrid config that itself belongs to a site). All operations are
-- scoped by has_site_access(site_id) -- staff who hold sites.view_all
-- pass regardless of grants; everyone else needs a matching row in
-- user_site_access.
-- ---------------------------------------------------------------------
drop policy team_all on site_snapshots;
create policy site_snapshots_scoped on site_snapshots
  for all to authenticated
  using ( (select has_site_access(site_id)) )
  with check ( (select has_site_access(site_id)) );

drop policy team_all on site_vulnerabilities;
create policy site_vulnerabilities_scoped on site_vulnerabilities
  for all to authenticated
  using ( (select has_site_access(site_id)) )
  with check ( (select has_site_access(site_id)) );

drop policy team_all on security_checks;
create policy security_checks_scoped on security_checks
  for all to authenticated
  using ( (select has_site_access(site_id)) )
  with check ( (select has_site_access(site_id)) );

drop policy team_all on uptime_checks;
create policy uptime_checks_scoped on uptime_checks
  for all to authenticated
  using ( (select has_site_access(site_id)) )
  with check ( (select has_site_access(site_id)) );

drop policy team_all on seo_snapshots;
create policy seo_snapshots_scoped on seo_snapshots
  for all to authenticated
  using ( (select has_site_access(site_id)) )
  with check ( (select has_site_access(site_id)) );

drop policy team_all on geogrid_configs;
create policy geogrid_configs_scoped on geogrid_configs
  for all to authenticated
  using ( (select has_site_access(site_id)) )
  with check ( (select has_site_access(site_id)) );

-- geogrid_snapshots has no site_id column of its own (see 0001_init.sql) --
-- it belongs to a geogrid_configs row via config_id, and that row carries
-- the site_id. Scope through the join rather than denormalizing a column
-- onto this table purely for RLS's sake.
drop policy team_all on geogrid_snapshots;
create policy geogrid_snapshots_scoped on geogrid_snapshots
  for all to authenticated
  using (
    (select has_site_access(geogrid_configs.site_id)
       from geogrid_configs
      where geogrid_configs.id = geogrid_snapshots.config_id)
  )
  with check (
    (select has_site_access(geogrid_configs.site_id)
       from geogrid_configs
      where geogrid_configs.id = geogrid_snapshots.config_id)
  );

drop policy team_all on reports;
create policy reports_scoped on reports
  for all to authenticated
  using ( (select has_site_access(site_id)) )
  with check ( (select has_site_access(site_id)) );

-- ---------------------------------------------------------------------
-- Staff-only tables: internal job queue and audit trail. No site grant
-- makes either of these visible -- only sites.view_all does.
-- ---------------------------------------------------------------------
drop policy team_all on jobs;
create policy jobs_staff_only on jobs
  for all to authenticated
  using ( (select authorize('sites.view_all')) )
  with check ( (select authorize('sites.view_all')) );

drop policy team_all on activity_log;
create policy activity_log_staff_only on activity_log
  for all to authenticated
  using ( (select authorize('sites.view_all')) )
  with check ( (select authorize('sites.view_all')) );

-- ---------------------------------------------------------------------
-- vuln_feed: shared reference data, not scoped per site. Every
-- authenticated user may read it; it is written only by the
-- feed-ingestion job, which runs on the service-role client.
-- ---------------------------------------------------------------------
drop policy team_all on vuln_feed;
create policy vuln_feed_select on vuln_feed
  for select to authenticated
  using ( true );

-- ---------------------------------------------------------------------
-- RBAC tables. These have had RLS enabled with zero policies since
-- 0006_rbac_schema.sql (default-deny) -- this is their first policy set.
-- Every user may read their own role, their own overrides and their own
-- site grants; only a holder of users.manage may write any of these
-- tables, or read anyone else's row. role_permissions is the exception:
-- the whole table is readable by any authenticated user, because the UI
-- needs it to show what a role can do.
-- ---------------------------------------------------------------------
create policy user_roles_select_own on user_roles
  for select to authenticated
  using ( user_id = (select auth.uid()) );

create policy user_roles_manage on user_roles
  for all to authenticated
  using ( (select authorize('users.manage')) )
  with check ( (select authorize('users.manage')) );

create policy role_permissions_select on role_permissions
  for select to authenticated
  using ( true );

create policy role_permissions_manage on role_permissions
  for all to authenticated
  using ( (select authorize('users.manage')) )
  with check ( (select authorize('users.manage')) );

create policy user_permission_overrides_select_own on user_permission_overrides
  for select to authenticated
  using ( user_id = (select auth.uid()) );

create policy user_permission_overrides_manage on user_permission_overrides
  for all to authenticated
  using ( (select authorize('users.manage')) )
  with check ( (select authorize('users.manage')) );

-- user_site_access's self-read is a BARE predicate, never has_site_access:
-- has_site_access() reads this very table, so using it here would make
-- the function and the policy recurse into each other.
create policy user_site_access_select_own on user_site_access
  for select to authenticated
  using ( user_id = (select auth.uid()) );

create policy user_site_access_manage on user_site_access
  for all to authenticated
  using ( (select authorize('users.manage')) )
  with check ( (select authorize('users.manage')) );
