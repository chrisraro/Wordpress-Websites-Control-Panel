-- Final whole-branch review, finding 4: a database-level backstop for the
-- last-admin invariant src/services/users/guards.ts already enforces in
-- application code (canChangeRole / canDeleteUser, wired through
-- src/services/users/service.ts's changeUserRole / deleteManagedUser).
--
-- Those application guards are the primary mechanism and stay that way --
-- they give a fast, specific, friendly refusal an admin actually reads in
-- the UI ("This is the last administrator..."), and this migration is not
-- a substitute for them; it never runs in the ordinary case. What they
-- cannot close on their own is a race: each guard does repo.listUsers()
-- (a read), evaluates the last-admin rule in JavaScript, then writes.
-- There is no transaction spanning the read and the write, and no row
-- lock held between them. Two administrators each demoting the other
-- inside the same second both read a two-admin world, both guards pass,
-- and both writes commit -- leaving zero rows with role = 'admin'.
-- users.manage is held only by admin in the seeded matrix
-- (0006_rbac_schema.sql), and setRolePermissionChecked's own guard
-- refuses to let an admin strip users.manage from the admin role, so once
-- the last admin is gone nobody can reach /users or the permission matrix
-- to fix it. Recovery is raw SQL against production -- exactly the state
-- spec §4 declares must be impossible, and exactly the state this
-- database-level refusal exists to make unreachable in the first place,
-- rather than merely repairable after the fact.
--
-- The lock is load-bearing, not decoration: `select 1 from user_roles
-- where role = 'admin'` with no `for update` is a plain read. Under
-- READ COMMITTED (Postgres's default, and this project's), a plain SELECT
-- takes no row lock and is satisfied entirely from the latest *committed*
-- snapshot -- it does not wait on, or even notice, a concurrent
-- transaction's uncommitted write to a row it reads. That reintroduces
-- exactly the race this trigger exists to close, just moved one layer
-- down: T1 demotes admin B (its own trigger firing sees B=developer,
-- A=admin untouched -- passes, commits). T2, overlapping, demotes admin A;
-- its trigger runs the same unlocked SELECT and still sees B=admin,
-- because T1 has not committed yet from T2's point of view -- passes,
-- commits. Zero admins, the trigger having fired twice and refused
-- nothing. `for update` changes this: it takes a row lock on every
-- user_roles row currently marked admin, so T2's SELECT ... FOR UPDATE
-- blocks until T1 either commits or rolls back holding that same row lock
-- (B's row), then re-reads under READ COMMITTED's read-committed-row
-- semantics -- seeing B's just-committed 'developer' role, finding no
-- admin rows left, and raising. `user_roles` is one row per account, so
-- the lock footprint of this is trivial; do not remove it as noise, it is
-- the entire reason two concurrent demotions can no longer both pass.
--
-- No deploy-order dependency: unlike 0012/0013, this migration does not
-- touch any application-visible shape (no column, no policy, nothing an
-- old build's queries depend on). It is safe to apply before, during or
-- after this branch's code goes live, in any order relative to 0010-0013.
--
-- It does forbid something on a database that has already reached zero
-- admins, though: every UPDATE or DELETE against user_roles, full stop,
-- not only the one statement that caused that state. That includes
-- operations with no intent whatsoever to touch this invariant --
-- scripts/verify-rls.ts's fixture cleanup (which deletes its own test rows
-- from tables including user_roles), the `granted_by ... on delete set
-- null` cascade that fires when the account that originally granted a
-- role is itself deleted, and rollbackFailedInvite's deliberate bypass of
-- the application-level lockout guards (src/services/users/service.ts)
-- when cleaning up a half-created invite. On a healthy database (at least
-- one admin) none of that is ever refused; the trigger only starts
-- refusing once the invariant it protects has already been violated by
-- some other route (direct SQL, a bug, a restore from an already-broken
-- backup). That is the intended behaviour, not a gap: refusing every
-- further UPDATE/DELETE is exactly what stops a zero-admin database from
-- being made harder to repair while someone fixes it. Recovery does not
-- require disabling this trigger -- INSERT is unguarded (see below), so
-- `insert into user_roles (user_id, role) values (...)`, or an upsert onto
-- an existing row, restores an admin in the same statement or a prior one
-- and every subsequent UPDATE/DELETE is unblocked again. The raised
-- exception's message says exactly this.
--
-- UPDATE and DELETE only -- deliberately no INSERT. INSERT can only ever
-- add a row to this table; it can never be the operation that takes the
-- admin count from one-or-more down to zero, so it has no possible part in
-- causing this invariant to break. Guarding it anyway would refuse
-- legitimate, unrelated statements: scripts/bootstrap-admin.ts (and any
-- environment's very first role grant of any kind) upserts a row into a
-- user_roles table that starts completely empty -- zero admins, because
-- there has never been anyone at all yet. Whatever role happens to be
-- granted first in a fresh environment must not be refused merely because
-- no admin exists *yet*; only a statement that could plausibly be
-- *removing* an already-existing admin -- an UPDATE changing role away
-- from 'admin', or a DELETE of an admin row (including the cascade delete
-- from auth.users that deleteManagedUser's auth.admin.deleteUser call
-- triggers) -- is in this trigger's scope.
--
-- ROW-level (`for each row`), not statement-level -- this supersedes an
-- earlier version of this migration that used `for each statement`.
-- Contrary to an earlier draft of this comment, Postgres does fire a
-- statement-level AFTER UPDATE trigger for `insert ... on conflict do
-- update` -- it has done so since 9.5 introduced ON CONFLICT (see
-- nodeModifyTable.c): a statement-level trigger's firing is governed by
-- which trigger events the statement's command could ever invoke, not by
-- which branch, if any, a given row actually took. So that is not the
-- reason to prefer row-level here. The real reason is that a
-- statement-level trigger fires unconditionally once per statement, even
-- when the DO UPDATE branch runs but changes zero rows (a conflict target
-- whose row already matches every assigned value, for instance) -- so a
-- statement-level version of this check would still evaluate the
-- invariant on a statement that never actually changed anyone's role,
-- which is at best a redundant check and at worst a spurious raise on an
-- unrelated no-op write. A row-level trigger has no such gap: Postgres's
-- documented behaviour for `insert ... on conflict do update` is that
-- row-level AFTER UPDATE triggers fire for exactly the rows that took the
-- DO UPDATE branch and were genuinely changed, the same as any other
-- UPDATE. repo.setRole (src/services/users/repo.ts) writes every role
-- change via `.upsert(..., { onConflict: "user_id" })`, which PostgREST
-- executes as this exact statement shape, so this is not a hypothetical --
-- it is this application's only demotion path. user_roles holds one row
-- per account, so the per-row cost of row-level firing over statement-level
-- is irrelevant here -- there is never more than one row to fire for per
-- account touched.
--
-- Multi-row statements still behave correctly under FOR EACH ROW: a single
-- `delete from user_roles where role = 'admin'` deletes every admin row in
-- one statement. Row-level AFTER triggers are queued while the statement's
-- modifications are being made and are only fired once those modifications
-- are complete, in some order, within that statement's transaction -- so
-- every firing this delete produces, not only the last, sees the
-- post-statement table: every admin row already gone. Postgres
-- re-evaluates `exists (select 1 from public.user_roles where role =
-- 'admin' for update)` fresh each time the function runs, so the very
-- first firing already finds zero admin rows and raises, and that
-- exception aborts the whole statement -- including every deletion in
-- it -- because all of it runs inside one transaction. The invariant is
-- enforced on the statement as a whole, not merely on each row in
-- isolation, exactly as the statement-level version intended; it is only
-- the mechanism (all firings see the same post-statement state, rather
-- than the first n-1 firings seeing partial progress) that differs from an
-- earlier draft of this comment, not the outcome.
--
-- security definer with set search_path = '' and every reference
-- schema-qualified, matching 0007_rbac_functions.sql's convention: an
-- empty search_path stops a lower-privileged caller from creating an
-- object that shadows an unqualified identifier and changing what this
-- function resolves to at call time. 0007 also revokes execute on its
-- SECURITY DEFINER helpers from public/anon/authenticated and grants it
-- back only to the roles that need to call them directly; this migration
-- matches that revoke below, even though there is no grant-back to add --
-- nothing in this codebase, and no role, ever calls require_one_admin()
-- directly. Only the trigger manager invokes it when the trigger fires,
-- and firing a trigger function does not require the firing role to hold
-- EXECUTE on it.
--
-- Re-runnable: `create or replace function` and `drop trigger if exists`
-- before `create trigger`, the same pattern 0011/0013 use for their own
-- re-run safety.

set local search_path = public;

create or replace function public.require_one_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.user_roles where role = 'admin' for update) then
    raise exception using
      errcode = '23514', -- check_violation: an operator error to act on, not a bug report
      message = 'Refusing this change: it would leave zero rows with role = admin in user_roles. '
        || 'Promote another account to admin before demoting or deleting the last one. If you '
        || 'are restoring from a backup or otherwise repairing a broken state, insert or update '
        || 'a user_roles row to admin in the same statement, or in a prior one.';
  end if;
  return null; -- ignored on an AFTER row-level trigger
end;
$$;

revoke all on function public.require_one_admin() from public, anon, authenticated;

drop trigger if exists user_roles_require_one_admin on public.user_roles;

create trigger user_roles_require_one_admin
  after update or delete on public.user_roles
  for each row
  execute function public.require_one_admin();
