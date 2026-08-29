-- Phase 9a: authorization functions. Written once, in Postgres, as
-- security definer functions; RLS policies (0008_rls_scoped.sql) and the
-- application call the same definitions, by RPC, so the two cannot drift.
--
-- Every function here is `set search_path = ''` with every object
-- reference schema-qualified. Without the empty search_path a
-- lower-privileged caller can create an object that shadows a bare
-- identifier and change what the function resolves to at call time.

-- authorize: does the calling user (auth.uid()) hold this permission?
-- Order matters: the override is checked BEFORE role_permissions. A
-- 'deny' override exists specifically to exclude one person from
-- something their role generally allows; checking the role first and
-- returning early on a match would make every 'deny' silently ineffective.
create or replace function public.authorize(
  requested_permission public.app_permission
) returns boolean language plpgsql stable security definer
set search_path = '' as $$
declare
  v_role public.app_role;
  v_effect public.override_effect;
begin
  select role into v_role from public.user_roles where user_id = (select auth.uid());
  if v_role is null then return false; end if;

  select effect into v_effect
  from public.user_permission_overrides
  where user_id = (select auth.uid()) and permission = requested_permission;
  if v_effect is not null then return v_effect = 'allow'; end if;

  return exists (
    select 1 from public.role_permissions
    where role = v_role and permission = requested_permission
  );
end $$;

-- authorize_for_user: identical rules to authorize(), but takes the user
-- id explicitly. The application's staff path runs on the service-role
-- client, where auth.uid() is null, so it cannot call authorize()
-- directly. A divergence between the two bodies would be a security bug,
-- not a style choice — keep them in lockstep.
create or replace function public.authorize_for_user(
  p_user_id uuid,
  requested_permission public.app_permission
) returns boolean language plpgsql stable security definer
set search_path = '' as $$
declare
  v_role public.app_role;
  v_effect public.override_effect;
begin
  select role into v_role from public.user_roles where user_id = p_user_id;
  if v_role is null then return false; end if;

  select effect into v_effect
  from public.user_permission_overrides
  where user_id = p_user_id and permission = requested_permission;
  if v_effect is not null then return v_effect = 'allow'; end if;

  return exists (
    select 1 from public.role_permissions
    where role = v_role and permission = requested_permission
  );
end $$;

-- has_site_access: true when the caller holds sites.view_all (staff see
-- every site), or has a user_site_access row for this site whose level
-- satisfies the minimum requested. A 'manage' grant satisfies both
-- 'read' and 'manage'; a 'read' grant satisfies only 'read'.
create or replace function public.has_site_access(
  p_site_id uuid,
  p_min_level public.site_access_level default 'read'
) returns boolean language sql stable security definer set search_path = '' as $$
  select
    (select public.authorize('sites.view_all'))
    or exists (
      select 1 from public.user_site_access
      where user_id = (select auth.uid())
        and site_id = p_site_id
        and (access_level = 'manage' or p_min_level = 'read')
    );
$$;

-- has_site_access_for_user: identical rules to has_site_access(), but
-- takes the user id explicitly, for the same reason authorize_for_user
-- exists — the service-role client has no auth.uid().
create or replace function public.has_site_access_for_user(
  p_user_id uuid,
  p_site_id uuid,
  p_min_level public.site_access_level default 'read'
) returns boolean language sql stable security definer set search_path = '' as $$
  select
    (select public.authorize_for_user(p_user_id, 'sites.view_all'))
    or exists (
      select 1 from public.user_site_access
      where user_id = p_user_id
        and site_id = p_site_id
        and (access_level = 'manage' or p_min_level = 'read')
    );
$$;

-- The _for_user variants take a caller-supplied user id with no session
-- check of their own, so only the trusted service-role client may call
-- them. Leaving them callable by `authenticated` would let any signed-in
-- user ask about any other user's permissions.
-- The auth.uid() variants are called by RLS policies, which execute as the
-- calling role, and by the app over RPC. They work today via Postgres's
-- default PUBLIC execute grant; naming the grant explicitly means a future
-- hardening step that revokes PUBLIC cannot silently switch authorization off.
grant execute on function public.authorize(public.app_permission) to authenticated;
grant execute on function public.has_site_access(uuid, public.site_access_level) to authenticated;

revoke all on function public.authorize_for_user(uuid, public.app_permission) from public, anon, authenticated;
grant execute on function public.authorize_for_user(uuid, public.app_permission) to service_role;

revoke all on function public.has_site_access_for_user(uuid, uuid, public.site_access_level) from public, anon, authenticated;
grant execute on function public.has_site_access_for_user(uuid, uuid, public.site_access_level) to service_role;
