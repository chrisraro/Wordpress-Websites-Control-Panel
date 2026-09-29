-- OPTIONAL, run by hand in the Supabase SQL editor. Not a migration.
--
-- Between the round-2 deploy and the fix in commit "fix(net): pair the
-- guarded fetch with undici's own fetch", every uptime check failed inside
-- the panel (not at the site) and was stored as down with http_status NULL.
-- Those rows make the client home's 30-day uptime and the site history
-- wrong. This removes only rows that match the bug's signature inside the
-- window you set: no HTTP status recorded, between the two timestamps.
--
-- 1) Set the window (UTC). Start = when the round-2 code went live on
--    Vercel; end = when the fix went live. Check Vercel > Deployments.
-- 2) Run the PREVIEW and confirm the counts look like "every site, every
--    5 minutes" and nothing outside the window.
-- 3) Run the DELETE inside the transaction; COMMIT only if the row count
--    matches the preview.

-- PREVIEW
select s.name, count(*) as false_down_rows,
       min(u.checked_at) as first_seen, max(u.checked_at) as last_seen
from uptime_checks u join sites s on s.id = u.site_id
where u.http_status is null
  and u.checked_at >= timestamptz '2026-09-29 00:00:00+00'   -- window start (edit)
  and u.checked_at <  timestamptz '2026-09-30 00:00:00+00'   -- window end (edit)
group by s.name
order by s.name;

-- DELETE (edit the same two timestamps, then run all three statements)
begin;
delete from uptime_checks
where http_status is null
  and checked_at >= timestamptz '2026-09-29 00:00:00+00'   -- window start (edit)
  and checked_at <  timestamptz '2026-09-30 00:00:00+00';  -- window end (edit)
-- Compare the "DELETE n" count with the preview total, then:
commit;   -- or: rollback;
