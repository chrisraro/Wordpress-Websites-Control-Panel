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
-- Deploy-order dependency: apply this BEFORE or WITH the code deploy that
-- introduces it, not after. The GeoGrid page's query already selects
-- `dismissed_at` as of that deploy; running the new code against the old
-- schema makes PostgREST 400 (undefined column, 42703) on every request to
-- that page, which the page's error handling turns into a silent loss of
-- both the in-progress and failed-run alerts (see review of
-- fix/geogrid-partial-runs, item 4) rather than a visible failure. The
-- reverse order is safe: old code against this new column ignores the
-- column it doesn't select, the same as any other additive migration.
-- `add column if not exists` makes the migration itself safely re-runnable.

set local search_path = public;

alter table jobs add column if not exists dismissed_at timestamptz;
