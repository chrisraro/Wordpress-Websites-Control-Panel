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
--     "(select ...)". For an uncorrelated call -- one with no reference to
--     the row being checked, e.g. "(select authorize('sites.manage'))" --
--     this makes Postgres evaluate it once per statement via an InitPlan.
--     For a correlated call -- one that references an outer column, e.g.
--     "(select has_site_access(site_id))" -- the wrapping does NOT produce
--     an InitPlan; it is a SubPlan evaluated once per row, same as an
--     unwrapped call would be. That is true of all nine column-scoped
--     policies below (every child-table read/write policy plus sites'),
--     not just the geogrid_snapshots join. We still wrap these
--     consistently: it is harmless, keeps the SQL uniform, and is correct
--     for the uncorrelated calls that share the same shape.
--   * no policy calls a helper that reads the table the policy protects --
--     see user_site_access's self-read policy below for the one case this
--     project would otherwise hit.
--
-- This migration has not been applied to any database, so it is written
-- to be re-run safely (every drop is "if exists") and not to depend on
-- ambient session state beyond what it sets itself.

set local search_path = public;

-- ---------------------------------------------------------------------
-- sites: read scoped by grant, write gated by the staff-only permission.
-- ---------------------------------------------------------------------
drop policy if exists team_all on sites;

create policy sites_select_scoped on sites
  for select to authenticated
  using ( (select has_site_access(id)) );

create policy sites_write on sites
  for all to authenticated
  using ( (select authorize('sites.manage')) )
  with check ( (select authorize('sites.manage')) );

-- ---------------------------------------------------------------------
-- Child tables: every row belongs to a site (or, for geogrid_snapshots,
-- to a geogrid config that itself belongs to a site). Reads are scoped by
-- has_site_access(site_id) at the default 'read' level -- staff who hold
-- sites.view_all pass regardless of grants; everyone else needs a matching
-- row in user_site_access. Writes require the stricter 'manage' level.
--
-- These must be two separate policies, not one `for all` at 'read' level:
-- Postgres OR's multiple permissive policies together, so a looser select
-- policy alongside a stricter all policy would not restrict anything --
-- the select policy would still pass every read-level grant straight
-- through to INSERT/UPDATE/DELETE. The only way to keep writes at
-- 'manage' is to never grant them at 'read' in the first place.
-- ---------------------------------------------------------------------
drop policy if exists team_all on site_snapshots;
drop policy if exists site_snapshots_scoped on site_snapshots;
create policy site_snapshots_read on site_snapshots
  for select to authenticated
  using ( (select has_site_access(site_id)) );
create policy site_snapshots_write on site_snapshots
  for all to authenticated
  using ( (select has_site_access(site_id, 'manage')) )
  with check ( (select has_site_access(site_id, 'manage')) );

drop policy if exists team_all on site_vulnerabilities;
drop policy if exists site_vulnerabilities_scoped on site_vulnerabilities;
create policy site_vulnerabilities_read on site_vulnerabilities
  for select to authenticated
  using ( (select has_site_access(site_id)) );
create policy site_vulnerabilities_write on site_vulnerabilities
  for all to authenticated
  using ( (select has_site_access(site_id, 'manage')) )
  with check ( (select has_site_access(site_id, 'manage')) );

drop policy if exists team_all on security_checks;
drop policy if exists security_checks_scoped on security_checks;
create policy security_checks_read on security_checks
  for select to authenticated
  using ( (select has_site_access(site_id)) );
create policy security_checks_write on security_checks
  for all to authenticated
  using ( (select has_site_access(site_id, 'manage')) )
  with check ( (select has_site_access(site_id, 'manage')) );

drop policy if exists team_all on uptime_checks;
drop policy if exists uptime_checks_scoped on uptime_checks;
create policy uptime_checks_read on uptime_checks
  for select to authenticated
  using ( (select has_site_access(site_id)) );
create policy uptime_checks_write on uptime_checks
  for all to authenticated
  using ( (select has_site_access(site_id, 'manage')) )
  with check ( (select has_site_access(site_id, 'manage')) );

drop policy if exists team_all on seo_snapshots;
drop policy if exists seo_snapshots_scoped on seo_snapshots;
create policy seo_snapshots_read on seo_snapshots
  for select to authenticated
  using ( (select has_site_access(site_id)) );
create policy seo_snapshots_write on seo_snapshots
  for all to authenticated
  using ( (select has_site_access(site_id, 'manage')) )
  with check ( (select has_site_access(site_id, 'manage')) );

drop policy if exists team_all on geogrid_configs;
drop policy if exists geogrid_configs_scoped on geogrid_configs;
create policy geogrid_configs_read on geogrid_configs
  for select to authenticated
  using ( (select has_site_access(site_id)) );
create policy geogrid_configs_write on geogrid_configs
  for all to authenticated
  using ( (select has_site_access(site_id, 'manage')) )
  with check ( (select has_site_access(site_id, 'manage')) );

-- geogrid_snapshots has no site_id column of its own (see 0001_init.sql) --
-- it belongs to a geogrid_configs row via config_id, and that row carries
-- the site_id. Scope through the join rather than denormalizing a column
-- onto this table purely for RLS's sake. Same read/write split as above.
drop policy if exists team_all on geogrid_snapshots;
drop policy if exists geogrid_snapshots_scoped on geogrid_snapshots;
create policy geogrid_snapshots_read on geogrid_snapshots
  for select to authenticated
  using (
    (select has_site_access(geogrid_configs.site_id)
       from geogrid_configs
      where geogrid_configs.id = geogrid_snapshots.config_id)
  );
create policy geogrid_snapshots_write on geogrid_snapshots
  for all to authenticated
  using (
    (select has_site_access(geogrid_configs.site_id, 'manage')
       from geogrid_configs
      where geogrid_configs.id = geogrid_snapshots.config_id)
  )
  with check (
    (select has_site_access(geogrid_configs.site_id, 'manage')
       from geogrid_configs
      where geogrid_configs.id = geogrid_snapshots.config_id)
  );

drop policy if exists team_all on reports;
drop policy if exists reports_scoped on reports;
create policy reports_read on reports
  for select to authenticated
  using ( (select has_site_access(site_id)) );
create policy reports_write on reports
  for all to authenticated
  using ( (select has_site_access(site_id, 'manage')) )
  with check ( (select has_site_access(site_id, 'manage')) );

-- ---------------------------------------------------------------------
-- jobs: a command channel, not a data table. src/services/jobs/handlers.ts
-- dispatches on jobs.type and executes with the service-role client and
-- the target site's decrypted WordPress credentials -- it performs no
-- authorization of its own, trusting that a row only exists because
-- enqueueJob() (also service-role) put it there.
--
-- sites.view_all is a READ-scope permission that content_writer holds.
-- Gating `for all` on it, as the previous version of this migration did,
-- would let any content_writer INSERT a row like
-- {"type":"plugin_install","site_id":"...","payload":{...}} and have the
-- cron processor install a plugin on a live customer site -- straight
-- past requirePermission("wp_toolkit.manage") in the application layer.
--
-- So: select only, gated on sites.view_all, and deliberately NO write
-- policy of any kind. Every legitimate enqueue goes through enqueueJob()
-- on the service-role client, which bypasses RLS entirely and does not
-- need a policy to do it. A write policy here -- at any permission level
-- -- would open a client-side path to enqueue arbitrary jobs; no such
-- path exists today and none should be added.
-- ---------------------------------------------------------------------
drop policy if exists team_all on jobs;
drop policy if exists jobs_staff_only on jobs;
create policy jobs_select_staff_only on jobs
  for select to authenticated
  using ( (select authorize('sites.view_all')) );

-- ---------------------------------------------------------------------
-- activity_log: an audit trail. If the staff it logs could edit or delete
-- their own entries, it would not be an audit trail. Select only, gated
-- on sites.view_all; every write goes through the service-role client.
-- ---------------------------------------------------------------------
drop policy if exists team_all on activity_log;
drop policy if exists activity_log_staff_only on activity_log;
create policy activity_log_select_staff_only on activity_log
  for select to authenticated
  using ( (select authorize('sites.view_all')) );

-- ---------------------------------------------------------------------
-- vuln_feed: shared reference data, not scoped per site. Every
-- authenticated user may read it; it is written only by the
-- feed-ingestion job, which runs on the service-role client.
-- ---------------------------------------------------------------------
drop policy if exists team_all on vuln_feed;
create policy vuln_feed_select on vuln_feed
  for select to authenticated
  using ( true );

-- ---------------------------------------------------------------------
-- RBAC tables. These have had RLS enabled with zero policies since
-- 0006_rbac_schema.sql (default-deny) -- this is their first policy set.
-- Every user may read their own role, their own overrides and their own
-- site grants; only a holder of users.manage may write any of these
-- tables, or read anyone else's row. role_permissions is the exception:
-- the whole table is readable by any authenticated user. In practice the
-- app reads it through the service-role client (src/lib/authz/server.ts)
-- and does not depend on this policy today; it is kept broad because the
-- table is a 23-row, low-sensitivity permission matrix, and a future
-- client-side UI may want to read it directly.
-- ---------------------------------------------------------------------
drop policy if exists user_roles_select_own on user_roles;
create policy user_roles_select_own on user_roles
  for select to authenticated
  using ( user_id = (select auth.uid()) );

drop policy if exists user_roles_manage on user_roles;
create policy user_roles_manage on user_roles
  for all to authenticated
  using ( (select authorize('users.manage')) )
  with check ( (select authorize('users.manage')) );

drop policy if exists role_permissions_select on role_permissions;
create policy role_permissions_select on role_permissions
  for select to authenticated
  using ( true );

drop policy if exists role_permissions_manage on role_permissions;
create policy role_permissions_manage on role_permissions
  for all to authenticated
  using ( (select authorize('users.manage')) )
  with check ( (select authorize('users.manage')) );

drop policy if exists user_permission_overrides_select_own on user_permission_overrides;
create policy user_permission_overrides_select_own on user_permission_overrides
  for select to authenticated
  using ( user_id = (select auth.uid()) );

drop policy if exists user_permission_overrides_manage on user_permission_overrides;
create policy user_permission_overrides_manage on user_permission_overrides
  for all to authenticated
  using ( (select authorize('users.manage')) )
  with check ( (select authorize('users.manage')) );

-- user_site_access's self-read is a BARE predicate, never has_site_access:
-- has_site_access() reads this very table, so using it here would make
-- the function and the policy recurse into each other.
drop policy if exists user_site_access_select_own on user_site_access;
create policy user_site_access_select_own on user_site_access
  for select to authenticated
  using ( user_id = (select auth.uid()) );

drop policy if exists user_site_access_manage on user_site_access;
create policy user_site_access_manage on user_site_access
  for all to authenticated
  using ( (select authorize('users.manage')) )
  with check ( (select authorize('users.manage')) );
