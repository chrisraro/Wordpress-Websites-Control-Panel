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
-- No deploy-order dependency: unlike 0012/0013, this migration does not
-- touch any application-visible shape (no column, no policy, nothing an
-- old build's queries depend on) and forbids nothing any existing row
-- already violates -- user_roles already has at least as many admins as
-- it has right now, or the application is already unrecoverable and this
-- migration cannot make that worse. It is safe to apply before, during or
-- after this branch's code goes live, in any order relative to 0010-0013.
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
-- Statement-level (`for each statement`, not `for each row`): the
-- invariant is about the state of the whole table once the statement has
-- finished, not about any one changed row in isolation, so the whole-table
-- admin count only needs checking once per statement, not re-run once per
-- affected row.
--
-- Known limitation, disclosed rather than silently shipped: repo.setRole
-- (src/services/users/repo.ts) writes every role change, including a
-- demotion, via `.upsert(..., { onConflict: "user_id" })`, which PostgREST
-- executes as `insert ... on conflict (user_id) do update ...`. Postgres
-- classifies a statement-level trigger's firing by the literal command
-- keyword used, not by whether any given row actually took the insert or
-- the conflict-update branch -- so a statement-level AFTER UPDATE trigger,
-- as this one is, does not fire for that upsert, even for a row that was
-- genuinely updated by it. It does fire for a plain `update` or `delete`
-- issued directly against this table (e.g. by an operator at a SQL
-- console, or by any future code path that stops upserting), and the
-- DELETE half fires for deleteManagedUser's cascade from auth.users today.
-- The application-level guards above remain the only enforcement of this
-- invariant on the upsert-based role-change path in the app's current
-- code; this migration's UPDATE half is a backstop for direct SQL against
-- this table, not (today) for that specific call. Flagged here rather than
-- silently narrowed to DELETE-only, so a future reader deciding whether
-- this is sufficient has the actual facts rather than an implied guarantee
-- this file does not keep.
--
-- security definer with set search_path = '' and every reference
-- schema-qualified, matching 0007_rbac_functions.sql's convention exactly
-- -- an empty search_path stops a lower-privileged caller from creating an
-- object that shadows an unqualified identifier and changing what this
-- function resolves to at call time.
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
  if not exists (select 1 from public.user_roles where role = 'admin') then
    raise exception using
      errcode = '23514', -- check_violation: an operator error to act on, not a bug report
      message = 'Refusing this change: it would leave zero rows with role = admin in user_roles. '
        || 'Promote another account to admin before demoting or deleting the last one. If you '
        || 'are restoring from a backup or otherwise repairing a broken state, insert or update '
        || 'a user_roles row to admin in the same statement, or in a prior one.';
  end if;
  return null; -- ignored on an AFTER statement-level trigger
end;
$$;

drop trigger if exists user_roles_require_one_admin on public.user_roles;

create trigger user_roles_require_one_admin
  after update or delete on public.user_roles
  for each statement
  execute function public.require_one_admin();
