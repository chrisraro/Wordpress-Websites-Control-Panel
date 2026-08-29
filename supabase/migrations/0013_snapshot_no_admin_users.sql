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
--
-- The strip below is a second, deliberate run of 0011's `update ... payload
-- - 'admin_users'` statement, not a leftover. `alter table ... add
-- constraint` with no `not valid` clause makes Postgres validate every
-- existing row before the constraint is allowed to exist -- so this
-- migration cannot add the constraint at all unless every row already
-- satisfies it. The documented sequence is 0011 -> (gap) -> deploy this
-- branch's code -> 0013. 0011's strip only cleans the rows that existed at
-- the moment 0011 ran; during the gap that follows, the still-deployed old
-- collectInventory keeps inserting *new* site_snapshots rows carrying
-- payload.admin_users (site_snapshots is insert-only history --
-- insertSnapshot in src/services/inventory/repo.ts never updates a row
-- after the fact, and multiple rows per site are kept). Those gap rows are
-- never touched by 0011's strip and would otherwise abort this migration's
-- `add constraint` with a check-constraint violation on the very database
-- it is written for, leaving the backstop unlanded and an operator
-- debugging a validation failure with no strip statement in either
-- migration to guide them. Running the strip again here, immediately
-- before the constraint, closes exactly that gap: 0011's strip cleans
-- history up to its own run, this strip cleans whatever the old code wrote
-- after that and before the new code went live, and only once both have
-- run can every row in the table satisfy the constraint being added.

set local search_path = public;

-- The strip and the `add constraint` below are two statements, each with its
-- own READ COMMITTED snapshot. If the old collector is somehow still live when
-- this runs -- an operator applying out of the documented order -- it can
-- insert a fresh admin_users-carrying row between them, and the constraint's
-- validation scan aborts the transaction. This lock blocks concurrent
-- INSERT/UPDATE on site_snapshots for the few milliseconds the two statements
-- take, so the table cannot change underneath them. It does not block reads.
lock table site_snapshots in share row exclusive mode;

update site_snapshots set payload = payload - 'admin_users' where payload ? 'admin_users';

alter table site_snapshots
  drop constraint if exists site_snapshots_no_admin_users;

alter table site_snapshots
  add constraint site_snapshots_no_admin_users
  check (not (payload ? 'admin_users'));
