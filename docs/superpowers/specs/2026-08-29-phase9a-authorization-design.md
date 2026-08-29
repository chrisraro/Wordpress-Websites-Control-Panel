# Phase 9a — Authorization Foundation (Design)

**Date:** 2026-08-29
**Status:** Approved for planning
**Depends on:** Phases 1–8 (merged). Extends `2026-08-27-wp-control-panel-design.md`.
**Followed by:** Phase 9b — user management UI (invite, role assignment, site grants, permission-matrix editor).

## Goal

Give the panel real authorization: four roles, an editable permission matrix, per-site grants, and enforcement on every page, server action, and route handler. At the end of this phase the application is secure and `rarochristian029@gmail.com` is the administrator.

## Non-goals

- **The user management UI.** Phase 9b. In 9a, roles and grants are assigned by SQL or the seed script. This is deliberate: the enforcement must be correct before there is a UI that can hand out access.
- **Self-service signup.** Access stays invite-only.
- **Custom roles.** The four roles are fixed; what each role *may do* is editable.
- **Changing what any existing feature does.** This phase adds gates, not behaviour.

---

## 1. Verified current state

Measured, not assumed, on 2026-08-29:

| | |
|---|---|
| Auth users | exactly one — `rarochristian029@gmail.com`, created 2026-08-27 |
| Sites connected | 2 |
| Server actions | 22 exported across 14 `"use server"` modules (20 excluding `login`/`logout`) |
| Dashboard pages | 12 |
| Route handlers | 6 (3 cron, 1 n8n webhook, 1 batch status, 1 public report file) |
| Existing RLS | every table has one policy: `for all to authenticated using (true) with check (true)` |
| Data access | `createServiceSupabase()` (service-role) in essentially all server code |

**The load-bearing fact:** the service-role key carries the Postgres `bypassrls` attribute. Today's RLS policies therefore constrain nothing that the application actually does, and rewriting them alone would change nothing. Any authorization guarantee must come from a path that is actually taken.

**A second fact that shapes the enforcement map:** *every exported function in a `"use server"` module is a publicly invokable HTTP endpoint*, whether or not any component imports it. `runConnectionTest` and `processQueueNowAction` are exported helpers, not just internal functions — both are directly callable by anyone who can guess the action id. Each needs its own check; guarding only the wrapper is not enough.

---

## 2. Model

### 2.1 Roles

A fixed enum: `admin`, `developer`, `content_writer`, `client`. One role per user.

```sql
create type app_role as enum ('admin', 'developer', 'content_writer', 'client');

create table user_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       app_role not null,
  granted_by uuid references auth.users(id),
  granted_at timestamptz not null default now()
);
```

**Role is read from this table on every request, not carried in the JWT.**

The standard Supabase pattern puts the role in the access token via a Custom Access Token hook, for speed. This design deliberately does not, for three reasons:

1. **Revocation latency.** A JWT claim is stale until the token refreshes — up to an hour by default. Removing a contractor's access should take effect on their next request, not eventually.
2. **The performance argument does not apply.** It buys one avoided query per request for a handful of users, and the permission matrix and site grants must be live table reads regardless, so the query happens anyway.
3. **It removes a manual configuration step.** The hook is registered in the Supabase dashboard, outside the migration history — easy to forget when creating a new environment, and silently degrading (everyone reads as their default role) when missed.

The per-request reads are wrapped in React's `cache()` so one render resolves them once.

### 2.2 Permissions

An enum, so a typo is a database error rather than a silent allow:

```sql
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

create table role_permissions (
  id         bigint generated always as identity primary key,
  role       app_role not null,
  permission app_permission not null,
  unique (role, permission)
);
```

`role_permissions` **is** the editable matrix. Phase 9b's UI is checkboxes over these rows; nothing else needs to change for an admin to re-scope a role.

Adding a permission to the enum is a migration — correct, because a new permission only exists when an engineer ships the module it guards.

### 2.3 Per-user overrides

```sql
create type override_effect as enum ('allow', 'deny');

create table user_permission_overrides (
  user_id    uuid not null references auth.users(id) on delete cascade,
  permission app_permission not null,
  effect     override_effect not null,
  granted_by uuid references auth.users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);
```

An override wins over the role default. `deny` exists so one person can be excluded from something their role generally allows, without inventing a role for them.

### 2.4 Site grants

```sql
create type site_access_level as enum ('read', 'manage');

create table user_site_access (
  user_id      uuid not null references auth.users(id) on delete cascade,
  site_id      uuid not null references sites(id) on delete cascade,
  access_level site_access_level not null default 'read',
  granted_by   uuid references auth.users(id),
  granted_at   timestamptz not null default now(),
  primary key (user_id, site_id)
);
create index on user_site_access (user_id);
```

Staff see every site by holding `sites.view_all`; they need no rows here. **A client sees a site only if a row grants it — there is no implicit access, ever.**

### 2.5 Default matrix

Seeded once; editable afterwards.

| Permission | admin | developer | content_writer | client |
|---|:---:|:---:|:---:|:---:|
| `sites.view_all` | ✓ | ✓ | ✓ | — |
| `sites.manage` | ✓ | — | — | — |
| `wp_toolkit.manage` | ✓ | ✓ | — | — |
| `security.run` | ✓ | ✓ | — | — |
| `seo.run` | ✓ | ✓ | ✓ | — |
| `geogrid.manage` | ✓ | ✓ | ✓ | — |
| `reports.generate` | ✓ | ✓ | ✓ | ✓ |
| `reports.manage` | ✓ | ✓ | — | — |
| `queue.process` | ✓ | ✓ | — | — |
| `users.manage` | ✓ | — | — | — |

`client` holds exactly one permission. Everything else a client can do follows from their site grants plus read access.

---

## 3. Authorization functions

Written **once**, in Postgres, as `security definer` functions. RLS policies call them; the application calls the same functions by RPC. One definition, two enforcement points, no drift.

```sql
create or replace function authorize(requested_permission app_permission)
returns boolean language plpgsql stable security definer
set search_path = '' as $$
declare
  -- Types must be schema-qualified too: with search_path = '' a bare
  -- `app_role` does not resolve, and the function fails to define.
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
```

`has_site_access(site_id, min_level)` returns true when the caller holds `sites.view_all`, or has a matching grant.

Because the app's staff path uses the service-role client — which has no `auth.uid()` — each function has a `_for_user(p_user_id, …)` sibling, executable only by `service_role`, that takes the id explicitly. Same body, same rules.

**Three requirements that are easy to miss and each cause a real failure:**

- **`set search_path = ''` on every `security definer` function.** Without it a lower-privileged caller can shadow an unqualified identifier and change what the function resolves. Every object reference inside is schema-qualified.
- **No policy may call a helper that reads the table the policy protects.** `user_site_access`'s own "see your own grants" policy uses a bare `user_id = auth.uid()` predicate, never `has_site_access`, or the two recurse.
- **Wrap calls as `(select authorize(...))` inside policies.** Postgres then evaluates them once per statement instead of once per row.

---

## 4. Enforcement

### 4.1 Two paths, chosen by role

**Staff — `admin`, `developer`, `content_writer`.** Keep the service-role client. Every server action, page, and route handler calls `requireUser()` and then an explicit permission check before touching data. Fast, and it suits decisions that are about feature visibility rather than row filtering.

**Clients.** Read through a **user-scoped** Supabase client (anon key + the user's own cookies), so RLS is the actual, database-enforced boundary. This is the point of the whole design: a client cannot read another client's site data even if application code is wrong, because Postgres refuses. This is the cheapest place to buy a real guarantee and the audience where it matters most.

**Cron and webhooks.** Unchanged — service-role with their existing shared-secret checks. They are not user requests and have no user to authorize.

**One clarification, because the split is about reads.** A client's *reads* go
through the user-scoped client so RLS scopes them. The single write a client can
perform — generating a report — still runs on the service-role client, because it
writes a row and uploads to a private bucket. It is gated exactly like a staff
action: `requireUser()`, then `reports.generate`, then `has_site_access`. So the
rule is "client reads are database-enforced; every write on any path is
explicitly checked", not "clients never touch service-role".

The failure mode to design against is **RLS theatre**: writing correct policies and then never routing anyone through a client that respects them. The client read path is therefore not optional polish; it is what makes the policies load-bearing.

### 4.2 Middleware is not a boundary

`src/middleware.ts` refreshes the session and redirects anonymous visitors. It performs **no** authorization and must never be given any.

Next.js CVE-2025-29927 allowed a crafted `x-middleware-subrequest` header to convince the framework middleware had already run, skipping it entirely — every app whose only gate was middleware was fully exposed. The lesson is not "patch and move on"; it is that middleware is an optimisation the framework can short-circuit. A comment in the file records this so a future contributor does not helpfully move a check there.

### 4.3 The enforcement map

Every surface, and what it requires. This table is the phase's checklist.

**Server actions** (20; `login`/`logout` are exempt by definition)

| Action | Requires |
|---|---|
| `createSite` | `sites.manage` |
| `runConnectionTest`, `testConnectionAction` | `sites.manage` + site access |
| `refreshInventoryAction` | site access (**manage**) — see note below |
| `manageAction` | `wp_toolkit.manage` + site access (manage) |
| `bulkAction` | `wp_toolkit.manage` + site access (manage) |
| `createChildThemeAction` | `wp_toolkit.manage` + site access (manage) |
| `installThemeAction`, `prepareThemeUploadAction` | `wp_toolkit.manage` + site access (manage) |
| `searchWpThemesAction` | authenticated only (proxies a public API) |
| `createInstallBatchAction`, `prepareUploadAction` | `wp_toolkit.manage` + site access on **every** target site |
| `runSecurityScanAction` | `security.run` + site access |
| `runSeoScanAction` | `seo.run` + site access |
| `saveGeoGridConfigAction`, `runGeoGridAction` | `geogrid.manage` + site access |
| `generateReportAction` | `reports.generate` + site access |
| `revokeReportAction` | `reports.manage` + site access |
| `processQueueNowAction`, `drainQueueAction` | `queue.process` |

`createInstallBatchAction` takes a **list** of site ids. It must check access to each one and reject the whole request if any fails — a partial check there is a cross-tenant hole.

`refreshInventoryAction` requires site access at **manage** level, not read. It is
read-only with respect to WordPress, so "site access" looks sufficient — but it
opens an MCP connection and runs PHP on the customer's site, and the brief for
`client` is "read and report generation" only. Clients hold `read` grants, so
requiring `manage` excludes them without a special case. Staff pass on
`sites.view_all` regardless of level.

**Pages** (12) — each re-checks; none relies on the layout having checked.

| Page | Behaviour |
|---|---|
| `/dashboard` | lists only sites the user may see |
| `/sites/new` | requires `sites.manage`, else 404 |
| `/sites/[id]` and all six tabs | requires site access, else 404 |
| `/marketplace`, `/marketplace/themes` | requires `wp_toolkit.manage`, else 404 |
| `/marketplace/batches/[id]` | requires `wp_toolkit.manage` |

**Route handlers** (6)

| Route | Behaviour |
|---|---|
| `/api/cron/*` (3) | unchanged — `CRON_SECRET` |
| `/api/webhooks/n8n/geogrid` | unchanged — HMAC or shared secret |
| `/api/batches/[id]` | authenticated **and** may see the sites in the batch |
| `/r/[token]/file` | unchanged — public share token, deliberately unauthenticated |

**404, not 403, for a site the user may not see.** A 403 confirms the site exists; a 404 does not. The panel already applies this to public share links and should be consistent.

---

## 5. What a client sees

A client's dashboard lists only their granted sites. Every tab renders read-only: the data is there, every action control is gone. Not disabled — absent. A greyed button invites a support ticket.

**Two fields are hidden outright**, on the site overview: `mcp_endpoint` and `wp_username`. They are credentials-adjacent, disclose the integration's shape, and no client has a reason to see either. The connection card renders without them for clients rather than showing blanks.

Reports remain fully available: a client can generate one for a site they hold, which is the point of giving them an account. `reports.manage` (revoking share links) is not theirs.

Hiding a control is presentation. Every one of those actions is independently gated server-side; the UI merely stops offering what the server would refuse.

---

## 6. RLS rewrite

The blanket `team_all` policy is replaced on all 12 existing tables. The shape, using `sites` as the example:

```sql
drop policy team_all on sites;

create policy sites_select_scoped on sites
  for select to authenticated
  using ( (select has_site_access(id)) );

create policy sites_write on sites
  for all to authenticated
  using ( (select authorize('sites.manage')) )
  with check ( (select authorize('sites.manage')) );
```

Child tables (`site_snapshots`, `security_checks`, `seo_snapshots`, `geogrid_*`, `reports`, `uptime_checks`, `site_vulnerabilities`) scope by `has_site_access(site_id)`. `jobs` and `activity_log` are staff-only. `vuln_feed` is shared reference data, readable by any authenticated user.

The four new tables get their own policies, with `user_site_access`'s self-read written as a bare predicate to avoid the recursion noted in §3.

The four new tables have RLS **enabled from the migration that creates them**,
with policies arriving here. That ordering matters: Supabase serves every
public-schema table over PostgREST to any holder of a session JWT and the anon
key, and this app already ships a browser anon client. A table with RLS off is
governed only by Supabase's default grants, so leaving `user_roles` unprotected
even briefly would let any authenticated user set their own role to `admin` over
the REST API, with no application code involved. RLS on with no policies is
default-deny; the service-role key carries `bypassrls`, so the app is unaffected.

RLS is enabled and correct on every table **regardless of which client path reads it** — it is the backstop for the next engineer's missed check, and Supabase's own security advisor expects it.

---

## 7. Seeding the first admin

An idempotent script, `scripts/bootstrap-admin.ts`, run manually once per environment with `BOOTSTRAP_ADMIN_EMAIL` set. It finds or invites the user, then upserts their `user_roles` row to `admin`.

**Not a migration and not `seed.sql`.** A migration that grants admin runs in every environment forever and is a backdoor with a friendly name; `seed.sql` never runs against a linked project at all. Explicit and deliberate is right for the one operation that creates an administrator.

For this deployment it promotes the existing `rarochristian029@gmail.com`. Because that account already exists, the script's invite path is skipped and only the role row is written.

---

## 8. Testing

Vitest, dependency injection, in-memory fakes — the existing pattern. 237 tests pass today and must still pass.

- **`authorize` / `has_site_access` decision logic** is mirrored by a pure TypeScript module so it can be table-tested exhaustively: role with permission, role without, allow-override, deny-override beating a role that allows, unknown user, client with a grant, client without, staff with `sites.view_all` and no grants.
- **The enforcement map is the test list.** Every row in §4.3 gets a test asserting the action refuses without the permission. A gate nobody tested is a gate nobody knows works.
- **Cross-tenant tests**, the ones that matter most: a client requesting a site they were not granted gets 404; `createInstallBatchAction` with one granted and one ungranted site is rejected entirely, and enqueues nothing.
- **RLS policies are verified against the real database**, not asserted in TypeScript. A script signs in as a seeded test client and confirms `select` on another client's site returns zero rows. Policies that were never executed are policies that were never tested.
- **A regression test that the middleware performs no authorization**, so the CVE-2025-29927 lesson does not get undone by a well-meaning refactor.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| A missed check on one action leaks data | The §4.3 map is exhaustive and each row is tested; RLS backstops the client path |
| RLS theatre — policies written, never enforced | Client reads route through the user-scoped client by design, and are tested against the real database |
| `security definer` search_path hijack | `set search_path = ''` on every function, all references schema-qualified |
| Policy recursion on `user_site_access` | Self-read uses a bare `auth.uid()` predicate, never the helper |
| Locking the only admin out mid-migration | The seed script runs before enforcement lands; the migration order in the plan puts role assignment first |
| A demoted user keeps access | Role is read per request, so revocation is immediate — the reason the JWT hook was declined |
| Exported helpers in `"use server"` modules are unguarded endpoints | `runConnectionTest` and `processQueueNowAction` are named explicitly in §4.3 |
