-- 0029: record whether each site's homepage can be framed by the panel.
--
-- The dashboard's site cards show the live homepage in a sandboxed frame.
-- Browsers refuse to render a page that sends X-Frame-Options or a CSP
-- frame-ancestors that excludes us, so the 5-minute uptime check reads those
-- headers from the response it already fetches and stores the verdict here;
-- cards for sites that refuse fall back to a screenshot.
--
-- Nullable: null = no response to judge (site down) and every row written
-- before this migration. Re-runnable.

alter table public.uptime_checks
  add column if not exists frameable boolean;

comment on column public.uptime_checks.frameable is
  'Homepage allows framing by the panel (no X-Frame-Options; CSP frame-ancestors admits it). null = unknown.';
