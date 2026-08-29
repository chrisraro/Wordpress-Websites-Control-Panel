-- fix/duplicate-cron-and-vuln-feed: adds an index for
-- SecurityRepo.newestFeedUpdatedAt() (src/services/security/repo.ts), which
-- now runs once per site per night from securityScan (the stale-feed warn)
-- plus once per vuln_feed_refresh job (the freshness guard in
-- src/services/security/scan.ts) -- both `order by updated_at desc limit 1`
-- queries against `vuln_feed`, which previously had no index on that column.
--
-- No deploy-order dependency: this is a pure read-path optimization. Nothing
-- in application code depends on this index existing to function correctly
-- (unlike 0015's dismissed_at, which has a hard dependency documented in
-- that file's header) -- omitting or delaying it only costs a sequential
-- scan, it never breaks a query. Safe to apply before, with, or after the
-- code that queries it; safe to skip a deploy cycle entirely if this needs
-- more review.
--
-- `if not exists` makes this migration itself safely re-runnable.

set local search_path = public;

create index if not exists vuln_feed_updated_at_idx on vuln_feed (updated_at desc);
