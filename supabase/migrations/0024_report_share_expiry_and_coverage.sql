-- 0024: report share-link expiry, and the security coverage a report was
-- built from (audit 2026-09-29, still-open 2 and 7).
--
-- Re-runnable: every statement is `if not exists`. Both columns are nullable
-- and have no default, so existing rows are untouched.
--
-- DEPLOY ORDER: apply this before deploying the code that selects these
-- columns (src/services/reports/repo.ts). PostgREST fails the whole select
-- when it names an unknown column, so the Reports tab and /r/<token> would
-- 404 until it is applied.

-- When the report's share link stops working. The app sets it to 30 days
-- after a manual report is generated or a link is (re)created, and
-- getByToken treats a past expiry exactly like a revoked link (uniform 404).
-- Null = no expiry: links minted before this migration are deliberately left
-- valid, so no existing row is updated here. Revoke one from the Reports tab
-- if it should stop working.
alter table reports
  add column if not exists share_expires_at timestamptz;

-- What the report's security section could not check, copied from the grade
-- row (security_checks.details.incomplete) at generation time. The share page
-- reads it from here because the site's grade may have changed since.
--   null      = no security section, or a grade from before coverage tracking
--   '{}'      = complete
alter table reports
  add column if not exists security_incomplete text[];
