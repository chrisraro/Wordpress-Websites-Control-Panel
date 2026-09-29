-- feat(jobs): per-site maintenance windows for bulk and fleet updates.
--
-- A bulk plugin update on a live client site changes how it behaves, and the
-- right moment for that is when the client's visitors are asleep -- not when
-- someone at OCS happens to press the button. This records, per site, when
-- that moment is. Queueing work "in each site's maintenance window" sets the
-- job's existing `scheduled_for` to the next window start
-- (src/services/maintenance/window.ts); claim_jobs (0022) already refuses to
-- claim a job before its scheduled_for, so nothing about the queue changes.
--
--   maintenance_days              weekdays in the window's own zone,
--                                 0 = Sunday … 6 = Saturday.
--   maintenance_start             local wall-clock start time.
--   maintenance_duration_minutes  how long the window stays open.
--   maintenance_timezone          IANA zone. Defaults to Asia/Manila, where
--                                 the agency and most of its clients are;
--                                 kept per site because some are not.
--
-- NULL days/start/duration = no window, and such a site runs "now" even when
-- a window run is chosen. The three are all-or-nothing: a half-set window is
-- a schedule nobody can read. The time zone is NOT NULL with a default so a
-- window can never be interpreted in "whatever zone the server is in".
--
-- Zone validity is checked in the application (Intl), not here: a check
-- constraint must be immutable and pg_timezone_names is not.
--
-- NOT GRANTED TO `authenticated`, and absent from SITE_COLUMNS, like
-- production_site_id (0026). A window is an internal scheduling detail;
-- clients see neither the window nor the "Next window" line. Staff read and
-- write it through the service-role client (src/services/maintenance/repo.ts).
--
-- Deploy order: apply before the code that reads these columns. Re-runnable.

set local search_path = public;

alter table sites add column if not exists maintenance_days int[] null;
alter table sites add column if not exists maintenance_start time null;
alter table sites add column if not exists maintenance_duration_minutes int null;
alter table sites
  add column if not exists maintenance_timezone text not null default 'Asia/Manila';

alter table sites drop constraint if exists sites_maintenance_window_complete;
alter table sites add constraint sites_maintenance_window_complete check (
  (maintenance_days is null and maintenance_start is null and maintenance_duration_minutes is null)
  or (
    maintenance_days is not null and maintenance_start is not null
    and maintenance_duration_minutes is not null
    and cardinality(maintenance_days) between 1 and 7
    and maintenance_days <@ array[0,1,2,3,4,5,6]
    and maintenance_duration_minutes between 15 and 720
  )
);

comment on column sites.maintenance_days is
  'Maintenance window weekdays (0=Sun..6=Sat) in maintenance_timezone. Null = no window. Staff-only.';
comment on column sites.maintenance_start is
  'Maintenance window local start time. Null = no window. Staff-only.';
comment on column sites.maintenance_duration_minutes is
  'Maintenance window length, 15-720 minutes. Null = no window. Staff-only.';
comment on column sites.maintenance_timezone is
  'IANA zone the window is expressed in. Staff-only.';
