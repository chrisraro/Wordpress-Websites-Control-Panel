-- Phase 9b, spec §5.1: database-level backstop for 0011_site_admin_users.sql's
-- payload split.
--
-- The strip in 0011 (`update site_snapshots set payload = payload -
-- 'admin_users' ...`) is a one-shot statement. After it runs, the only
-- thing keeping admin_users out of newly-inserted payloads is a
-- destructuring expression in collectInventory
-- (src/services/inventory/service.ts). A revert of that application code,
-- or a later "simplification" back to spreading the raw MCP response, would
-- silently re-publish admin logins to every client with a grant, with
-- nothing failing -- unless the database itself refuses the row.
--
-- This constraint is that refusal, and it must NOT ship in the same
-- migration as 0011. The moment it exists, any insert or update whose
-- payload still carries an admin_users key is rejected -- and until the
-- code in this branch is deployed, that is every snapshot write in
-- production: the still-running old collectInventory still writes
-- admin_users into the payload it stores. Applying this constraint before
-- that deploy fails every refreshInventoryAction, every snapshot_refresh
-- job, and every security_scan that calls refreshSnapshot because it found
-- no cached snapshot (all of them, on a cold site) with a check-constraint
-- violation.
--
-- Apply this migration only after the code in this branch is live -- the
-- same deploy-after-code rule that governs
-- 0012_revoke_site_credential_columns.sql. It is numbered after 0012
-- because 0012 is already claimed by that column revoke; this one has no
-- ordering dependency on 0012 itself, only on this branch's deploy.

set local search_path = public;

alter table site_snapshots
  drop constraint if exists site_snapshots_no_admin_users;

alter table site_snapshots
  add constraint site_snapshots_no_admin_users
  check (not (payload ? 'admin_users'));
