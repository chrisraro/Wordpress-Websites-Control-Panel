-- Phase 9a: authorization schema. Roles, an editable permission matrix,
-- per-user overrides, and per-site grants. Nothing here is enforced yet —
-- that is a later task. RLS is enabled below with deliberately zero
-- policies: these tables decide who is an admin, and Supabase exposes
-- every public-schema table over PostgREST to anyone holding a valid
-- session JWT plus the anon key, regardless of what this app's own
-- server code does. RLS-enabled-with-no-policies default-denies that
-- path for every non-owner role, while the service-role key (which
-- carries bypassrls) keeps the application working unchanged. The
-- scoped policies land in 0008_rls_scoped.sql.

-- Enums
create type app_role as enum ('admin', 'developer', 'content_writer', 'client');

create type app_permission as enum (
  'sites.view_all',      -- see every site rather than only granted ones
  'sites.manage',        -- connect, edit, disable a site; touches credentials
  'wp_toolkit.manage',   -- plugins, themes, core, maintenance, child themes, bulk
  'security.run',        -- run a security scan
  'seo.run',             -- run an SEO/AEO scan
  'geogrid.manage',      -- configure and run GeoGrid
  'reports.generate',    -- generate a report
  'reports.manage',      -- revoke share links
  'queue.process',       -- drain the job queue on demand
  'users.manage'         -- invite users, set roles, edit the matrix (Phase 9b)
);

create type override_effect as enum (
  'allow',
  'deny'
);

create type site_access_level as enum (
  'read',
  'manage'
);

-- Roles: one per user. Read from this table on every request, not carried
-- in the JWT — see design doc §2.1 for why (revocation latency, no free
-- lunch on performance, one less manual dashboard step to forget).
create table user_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       app_role not null,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now()
);

-- The editable permission matrix. Phase 9b's admin UI is checkboxes over
-- these rows; nothing else needs to change for an admin to re-scope a role.
create table role_permissions (
  id         bigint generated always as identity primary key,
  role       app_role not null,
  permission app_permission not null,
  unique (role, permission)
);

-- Per-user overrides. Wins over the role default in either direction —
-- 'deny' lets one person be excluded from something their role generally
-- allows, without inventing a role just for them.
create table user_permission_overrides (
  user_id    uuid not null references auth.users(id) on delete cascade,
  permission app_permission not null,
  effect     override_effect not null,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);

-- Per-site grants. Staff see every site by holding sites.view_all and need
-- no rows here. A client sees a site only if a row grants it — there is no
-- implicit access, ever.
create table user_site_access (
  user_id      uuid not null references auth.users(id) on delete cascade,
  site_id      uuid not null references sites(id) on delete cascade,
  access_level site_access_level not null default 'read',
  granted_by   uuid references auth.users(id) on delete set null,
  granted_at   timestamptz not null default now(),
  primary key (user_id, site_id)
);
create index on user_site_access (user_id);

-- Default matrix, seeded once. An admin edits role_permissions afterwards
-- (Phase 9b). No user_roles row is seeded here — granting admin from a
-- migration would run in every environment forever, which is a backdoor;
-- a separate script handles that in a later task.
insert into role_permissions (role, permission) values
  ('admin', 'sites.view_all'),
  ('admin', 'sites.manage'),
  ('admin', 'wp_toolkit.manage'),
  ('admin', 'security.run'),
  ('admin', 'seo.run'),
  ('admin', 'geogrid.manage'),
  ('admin', 'reports.generate'),
  ('admin', 'reports.manage'),
  ('admin', 'queue.process'),
  ('admin', 'users.manage'),
  ('developer', 'sites.view_all'),
  ('developer', 'wp_toolkit.manage'),
  ('developer', 'security.run'),
  ('developer', 'seo.run'),
  ('developer', 'geogrid.manage'),
  ('developer', 'reports.generate'),
  ('developer', 'reports.manage'),
  ('developer', 'queue.process'),
  ('content_writer', 'sites.view_all'),
  ('content_writer', 'seo.run'),
  ('content_writer', 'geogrid.manage'),
  ('content_writer', 'reports.generate'),
  ('client', 'reports.generate')
on conflict (role, permission) do nothing;

-- RLS: enabled, deliberately policy-free. See header comment for why.
alter table user_roles enable row level security;
alter table role_permissions enable row level security;
alter table user_permission_overrides enable row level security;
alter table user_site_access enable row level security;
