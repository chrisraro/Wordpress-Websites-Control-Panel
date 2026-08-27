-- Enums
create type site_status as enum ('connected','degraded','reconnect_needed','disabled');
create type job_status as enum ('pending','running','awaiting_callback','done','failed');
create type check_result as enum ('pass','fail','warn');
create type vuln_status as enum ('open','fixed','ignored');

-- Sites
create table sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  mcp_endpoint text not null,
  wp_username text not null,
  app_password_encrypted text not null,
  status site_status not null default 'connected',
  client_label text,
  capabilities jsonb not null default '{}'::jsonb,
  consecutive_failures int not null default 0,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (url)
);

create table site_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  taken_at timestamptz not null default now(),
  payload jsonb not null
);
create index on site_snapshots (site_id, taken_at desc);

create table vuln_feed (
  id text primary key,
  software_slug text not null,
  software_type text not null,
  affected_versions jsonb not null,
  cve text,
  cvss numeric,
  title text,
  fixed_in text,
  updated_at timestamptz not null default now()
);
create index on vuln_feed (software_slug, software_type);

create table site_vulnerabilities (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  feed_id text not null references vuln_feed(id),
  component text not null,
  installed_version text not null,
  severity text,
  status vuln_status not null default 'open',
  first_seen timestamptz not null default now(),
  unique (site_id, feed_id, component)
);

create table security_checks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  run_at timestamptz not null default now(),
  check_id text not null,
  result check_result not null,
  details jsonb
);
create index on security_checks (site_id, run_at desc);

create table uptime_checks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  checked_at timestamptz not null default now(),
  http_status int,
  response_ms int,
  ssl_days_remaining int,
  ok boolean not null
);
create index on uptime_checks (site_id, checked_at desc);

create table seo_snapshots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  taken_at timestamptz not null default now(),
  source text not null,
  payload jsonb not null
);
create index on seo_snapshots (site_id, source, taken_at desc);

create table geogrid_configs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  business_name text not null,
  place_ref text,
  keywords text[] not null default '{}',
  grid_size int not null default 7 check (grid_size in (3,5,7,9)),
  spacing_m int not null default 1000,
  center_lat double precision not null,
  center_lng double precision not null,
  provider text not null default 'stub' check (provider in ('stub','n8n')),
  created_at timestamptz not null default now()
);

create table geogrid_snapshots (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references geogrid_configs(id) on delete cascade,
  run_at timestamptz not null default now(),
  keyword text not null,
  points jsonb not null
);
create index on geogrid_snapshots (config_id, run_at desc);

create table reports (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  generated_at timestamptz not null default now(),
  sections text[] not null,
  period_start date,
  period_end date,
  storage_path text not null,
  share_token text unique,
  auto boolean not null default false
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  site_id uuid references sites(id) on delete cascade,
  batch_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status job_status not null default 'pending',
  attempts int not null default 0,
  scheduled_for timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text
);
create index on jobs (status, scheduled_for);
create index on jobs (batch_id) where batch_id is not null;

create table activity_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid not null,
  site_id uuid references sites(id) on delete set null,
  action text not null,
  detail jsonb,
  at timestamptz not null default now()
);
create index on activity_log (site_id, at desc);

-- updated_at trigger for sites
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger sites_updated_at before update on sites
  for each row execute function set_updated_at();

-- RLS: team-only. Authenticated users get full access; anon gets nothing.
-- (Server-side cron/service code uses the service role key, which bypasses RLS.)
do $$
declare t text;
begin
  foreach t in array array[
    'sites','site_snapshots','vuln_feed','site_vulnerabilities','security_checks',
    'uptime_checks','seo_snapshots','geogrid_configs','geogrid_snapshots',
    'reports','jobs','activity_log'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy team_all on %I for all to authenticated using (true) with check (true)', t
    );
  end loop;
end $$;
