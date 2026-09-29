-- Database backstop for the role/permission write guards (2026-09-29).
--
-- The app now refuses (src/services/users/service.ts): changing your own
-- role, assigning `admin` unless you are an admin, and editing the
-- role x permission matrix unless you are an admin. The RLS policies from
-- 0008 still let any `users.manage` holder do all of that directly through
-- PostgREST with their own session, skipping the server actions, and also
-- write user_permission_overrides -- which no app path writes at all, so a
-- users.manage holder could grant themselves any permission. This makes
-- the database agree with the app:
--
--   role_permissions            write: admins only
--   user_permission_overrides   write: admins only
--   user_roles                  write: users.manage, never your own row,
--                               and a row naming 'admin' only by an admin
--
-- Reads are unchanged (the *_select policies are separate). The service
-- role bypasses RLS as before, so server actions are unaffected.
--
-- current_user_is_admin() is SECURITY DEFINER so a policy on user_roles can
-- ask "is the caller an admin" without the policy recursing into itself.
-- Re-runnable.

set local search_path = public;

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_roles where user_id = auth.uid() and role = 'admin'
  );
$$;

revoke execute on function public.current_user_is_admin() from public, anon;
grant execute on function public.current_user_is_admin() to authenticated;

drop policy if exists role_permissions_manage on role_permissions;
create policy role_permissions_manage on role_permissions
  for all to authenticated
  using ( (select authorize('users.manage')) and (select current_user_is_admin()) )
  with check ( (select authorize('users.manage')) and (select current_user_is_admin()) );

drop policy if exists user_permission_overrides_manage on user_permission_overrides;
create policy user_permission_overrides_manage on user_permission_overrides
  for all to authenticated
  using ( (select authorize('users.manage')) and (select current_user_is_admin()) )
  with check ( (select authorize('users.manage')) and (select current_user_is_admin()) );

drop policy if exists user_roles_manage on user_roles;
create policy user_roles_manage on user_roles
  for all to authenticated
  using (
    (select authorize('users.manage'))
    and user_id <> (select auth.uid())
    and (role <> 'admin' or (select current_user_is_admin()))
  )
  with check (
    (select authorize('users.manage'))
    and user_id <> (select auth.uid())
    and (role <> 'admin' or (select current_user_is_admin()))
  );
