-- Covering indexes for foreign keys and per-site lookups, plus two function
-- grants left at the Postgres default (2026-09-29 audit).
--
-- Indexes. Each of these columns is filtered on by app code or scanned by an
-- ON DELETE CASCADE from `sites`, and none had an index:
--   jobs(site_id, type, status)  pendingExists per site on every nightly
--                                enqueue and fleet action; listJobs .in(site_id);
--                                claim_jobs' per-site running check (0022);
--                                the cascade when a site is deleted.
--   reports(site_id, generated_at desc)  the Reports tab and the report tools.
--   geogrid_configs(site_id)     the GeoGrid tab.
--   site_vulnerabilities(feed_id) the cascade from vuln_feed replacement.
--   user_site_access(site_id)    grant lookups by site and the site cascade.
--
-- Plain `create index` (not concurrently) so this applies inside the SQL
-- editor's transaction like every other migration here. The tables are small
-- (a dozen sites), so the brief lock is immaterial. `if not exists` makes it
-- re-runnable.
--
-- Grants. authorize() and has_site_access() (0007) kept the default EXECUTE
-- for PUBLIC, so `anon` could call them. They return false without a
-- session, so this was harmless, but every other function in the RBAC set
-- revokes PUBLIC explicitly; match them. `authenticated` keeps EXECUTE,
-- which the RLS policies need.

set local search_path = public;

create index if not exists jobs_site_type_status_idx on jobs (site_id, type, status);
create index if not exists reports_site_generated_idx on reports (site_id, generated_at desc);
create index if not exists geogrid_configs_site_idx on geogrid_configs (site_id);
create index if not exists site_vulnerabilities_feed_idx on site_vulnerabilities (feed_id);
create index if not exists user_site_access_site_idx on user_site_access (site_id);

revoke execute on function authorize(app_permission) from public, anon;
revoke execute on function has_site_access(uuid, site_access_level) from public, anon;
grant execute on function authorize(app_permission) to authenticated;
grant execute on function has_site_access(uuid, site_access_level) to authenticated;
