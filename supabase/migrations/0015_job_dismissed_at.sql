-- fix/geogrid-partial-runs: lets a failed-run alert on the GeoGrid page be
-- cleared without deleting the job row it is reporting on.
--
-- Before this column, the only way to stop a resolved failure (e.g. two
-- stale HTTP 404s from a since-fixed n8n misconfiguration) from sitting on
-- the GeoGrid page forever was to delete the jobs row outright, destroying
-- the very diagnostic record `last_error` exists to keep. `dismissed_at`
-- gives the page something to filter on instead: the row, its `status`,
-- and its `last_error` are untouched -- only this one column changes, via
-- JobsRepo.dismissFailed (src/services/jobs/repo.ts), which is reachable
-- only from the service-role client because jobs carries no write policy
-- (0008_rls_scoped.sql).
--
-- No deploy-order dependency, the same class of change as
-- 0014_require_one_admin.sql: this adds a column no old build's queries
-- reference, so it is safe to apply before, during or after this branch's
-- code goes live, in any order relative to 0001-0014. `add column if not
-- exists` makes the migration itself safely re-runnable too.

set local search_path = public;

alter table jobs add column if not exists dismissed_at timestamptz;
