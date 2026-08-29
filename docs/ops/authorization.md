# Authorization (roles, permissions, site grants)

Spec: `docs/superpowers/specs/2026-08-29-phase9a-authorization-design.md`.
Schema: `supabase/migrations/0006_rbac_schema.sql`, `0007_rbac_functions.sql`,
`0008_rls_scoped.sql`, `0009_rbac_write_scope.sql`,
`0010_vuln_write_permission.sql`, `0011_site_admin_users.sql` and
`0013_snapshot_no_admin_users.sql`. 0006-0009 are applied to the live
database; **0010, 0011 and 0013 still need applying.** (0012 is a separate,
later change — the site-credential column revoke — not covered here.)
`0009` corrects a gap in `0008`'s write policies (see below); `0010` fixes one
permission mapping in `0009` — `site_vulnerabilities` writes require
`security.run`, not `wp_toolkit.manage`, because the security scan is the only
thing that writes them.

`0011` moves WordPress administrator identities into their own staff-only
table (see "Known exposures" below, item 1) — **it must be applied before
this code is deployed.** The application code reads `site_admin_users`
unconditionally for any viewer who holds `sites.view_all` (`latestAdminUsers`
in `src/services/inventory/repo.ts`, called from the site overview page);
deploying the code before the migration creates the table means that read
throws on a missing relation, 500ing every site overview page for staff.

`0013` adds the check constraint that backstops `0011`'s payload split
(`site_snapshots_no_admin_users`, rejecting any `site_snapshots` row whose
`payload` still carries an `admin_users` key). It has the **opposite**
deploy-order rule from `0011`: **it must be applied only after this code is
deployed**, the same deploy-after-code rule that governs
`0012_revoke_site_credential_columns.sql`. Until the code that stops writing
`admin_users` into the payload is live, the still-deployed old
`collectInventory` writes that key on every refresh; landing the constraint
first rejects every one of those writes — every `refreshInventoryAction`,
every `snapshot_refresh` job, and every `security_scan` that falls back to
`refreshSnapshot` because it found no cached snapshot — with a
check-constraint violation.

## The four roles and the default matrix

Roles are a Postgres enum (`app_role`): `admin`, `developer`, `content_writer`,
`client`. Every account has exactly one, in `user_roles.role`. There is no
"no role" state that still works — a user with no `user_roles` row is denied
everything (`getViewer()` in `src/lib/authz/server.ts` returns `null`), which
is why the bootstrap script has to run before anyone can use the app at all
(see "Deploy ordering" below).

`role_permissions` is the editable matrix: one row per `(role, permission)`
that role holds. Seeded once by `0006_rbac_schema.sql`:

| permission | admin | developer | content_writer | client |
|---|---|---|---|---|
| `sites.view_all` | yes | yes | yes | no |
| `sites.manage` | yes | no | no | no |
| `wp_toolkit.manage` | yes | yes | no | no |
| `security.run` | yes | yes | no | no |
| `seo.run` | yes | yes | yes | no |
| `geogrid.manage` | yes | yes | yes | no |
| `reports.generate` | yes | yes | yes | yes |
| `reports.manage` | yes | yes | no | no |
| `queue.process` | yes | yes | no | no |
| `users.manage` | yes | no | no | no |

`client` holds only `reports.generate`. It has no `sites.view_all`, so a
client sees nothing by role — every site it can see comes from an explicit
row in `user_site_access` (see below). `sites.view_all` is what makes a role
"staff": it also short-circuits `has_site_access()`, so a developer or admin
needs no per-site grants at all.

Two more tables adjust the matrix per user rather than per role:

- `user_permission_overrides` — one row per `(user_id, permission)`, with
  effect `allow` or `deny`. Checked *before* the role default in both
  `authorize()` and `authorize_for_user()` (`0007_rbac_functions.sql`), so a
  `deny` override always wins even though the role would otherwise allow it.
  This is how one person is excluded from something their role generally
  grants, without inventing a role just for them.
- `user_site_access` — one row per `(user_id, site_id)`, with `access_level`
  `read` or `manage`. A `manage` grant satisfies both `read` and `manage`
  checks; a `read` grant satisfies only `read`.

  **This does not, by itself, separate "can see this site's data" from "can
  change it".** `0008_rls_scoped.sql`'s child-table `_write` policies were
  written as `has_site_access(site_id, 'manage')` alone, and
  `has_site_access()` opens with `(select authorize('sites.view_all')) or
  ...` — a check that short-circuits to `true` for anyone holding
  `sites.view_all` regardless of the `'manage'` argument. `sites.view_all` is
  a *read*-scope permission that `content_writer` holds, so under `0008`
  alone a `content_writer` could write any of the eight child tables
  (`site_snapshots`, `site_vulnerabilities`, `security_checks`,
  `uptime_checks`, `seo_snapshots`, `geogrid_configs`, `geogrid_snapshots`,
  `reports`) over PostgREST with their own session, with no `manage`-level
  site grant and none of `wp_toolkit.manage`, `security.run`, `seo.run`,
  `geogrid.manage` or `reports.manage`.

  `0009_rbac_write_scope.sql` closes this. Each of those eight `_write`
  policies now requires **both** a real per-site `manage` grant — checked by
  a new helper, `has_site_grant_at_least()`, which never consults
  `sites.view_all` — **and** `authorize()` for the permission that governs
  that table. `has_site_access()` itself is unchanged; it is still correct
  for every `_read` policy and for `sites_select_scoped`, which do mean to
  let `sites.view_all` see everything. Staff who hold `sites.view_all` but no
  per-site grant can no longer write these tables through the anon/user-scoped
  client as a result — that's fine, because every legitimate write already
  goes through the service-role client, which bypasses RLS entirely.

## Changing a role or a site grant by SQL (until Phase 9b ships)

There is no admin UI for this yet — Phase 9b adds one. Until then, use the
Supabase SQL editor (or `psql`) directly. Find the user's id first:

```sql
select id, email from auth.users where email = 'someone@example.com';
```

Set or change a role:

```sql
insert into user_roles (user_id, role, granted_by)
values ('<user-id>', 'developer', '<admin-user-id>')
on conflict (user_id) do update set role = excluded.role, granted_by = excluded.granted_by;
```

Grant a client one site, read-only:

```sql
insert into user_site_access (user_id, site_id, access_level, granted_by)
values ('<user-id>', '<site-id>', 'read', '<admin-user-id>')
on conflict (user_id, site_id) do update set access_level = excluded.access_level;
```

Revoke it:

```sql
delete from user_site_access where user_id = '<user-id>' and site_id = '<site-id>';
```

Add a one-off override (e.g. deny a developer `wp_toolkit.manage` without
demoting them):

```sql
insert into user_permission_overrides (user_id, permission, effect, granted_by)
values ('<user-id>', 'wp_toolkit.manage', 'deny', '<admin-user-id>')
on conflict (user_id, permission) do update set effect = excluded.effect;
```

## Revocation is immediate, not eventual

`getViewer()` reads `user_roles`, `user_permission_overrides` and
`user_site_access` fresh on every request (`cache()`-scoped to that one
request's render, not across requests). Nothing is carried in the session JWT.
Deleting a `user_site_access` row or changing a role takes effect on that
user's *very next request* — there is no token to expire, no cache to bust,
and no second dashboard step to remember. The cost of this is one extra round
of queries per request; that trade was made deliberately (spec §2.1) because a
revoked contractor keeping access until their token happens to refresh is a
worse failure mode than a few extra milliseconds.

## Why middleware holds no authorization checks

`src/middleware.ts` refreshes the Supabase session and redirects anonymous
visitors to `/login`. That is the entire extent of it — no role check, no
permission check, no site-grant check. This is deliberate, not an oversight:
Next.js CVE-2025-29927 let a crafted `x-middleware-subrequest` header convince
the framework that middleware had already run, skipping it entirely. Any app
whose only gate lived in middleware was fully exposed by that bug. Every real
check lives in the page, server action, or route handler itself — middleware
is an optimization the framework is free to short-circuit, not a security
boundary. If you touch `src/middleware.ts`, keep it that way: it may redirect
based on session presence only, never on role or permission.

## RLS is the backstop, not the primary gate

Every server action and page in this app checks permissions explicitly in
TypeScript before doing anything, using the same `authorize()` /
`has_site_access()` logic mirrored in `src/lib/authz/decide.ts`. Almost all of
those checks run on the service-role Supabase client, which carries
`bypassrls` and ignores every RLS policy — so for staff roles, RLS enforces
nothing today; it exists so a missed application-level check fails safe
instead of failing open.

The one path where RLS is the *actual* enforcement, not just a backstop: a
`client`-role viewer's reads go through a user-scoped Supabase client instead
of the service-role one (`readDbFor()` in `src/lib/authz/db.ts`). For that
client, Postgres itself — not this application's code — is what stops them
from reading another client's site. That is exactly what `verify-rls.ts`
proves against the live database (below).

## Deploy ordering: migrations and bootstrap before enforcement

Apply migrations `0006`, `0007`, `0008` (in that order — `0008` depends on the
functions in `0007`, which depend on the tables in `0006`) and run
`bootstrap:admin` **before** deploying any code that enforces permissions. A
user with no `user_roles` row is denied everything, so if enforcement ships
before at least one admin row exists, nobody — including whoever is
deploying — can do anything in the app until someone runs the bootstrap
script directly against the database.

```bash
BOOTSTRAP_ADMIN_EMAIL=someone@example.com npm run bootstrap:admin
```

This is idempotent and safe to re-run: it finds-or-invites the user, then
upserts their `user_roles` row to `admin`. It is a script, not a migration or
`seed.sql`, on purpose — see the comment at the top of
`scripts/bootstrap-admin.ts`.

## Re-running the live RLS verification

`scripts/verify-rls.ts` is the only check in this phase that proves the
database actually refuses, rather than asserting refusal against a mock. It
creates a throwaway Supabase Auth user, gives it role `client` and a `read`
grant on exactly one site, signs in as that user with the anon key, and runs
six queries through that real, RLS-governed session:

1. `select` on `sites` returns exactly the granted site.
2. `select` on `sites` filtered to the *other* site returns zero rows.
3. `select` on `site_snapshots` for the other site returns zero rows.
4. `update` on the granted site is rejected (a `read` grant is not `manage`).
5. `insert` into `site_snapshots` for the granted site is rejected (same
   read/manage split, on a child table).
6. `select` on `jobs` returns zero rows (`jobs` is staff-only, gated on
   `sites.view_all`, which `client` never holds).

It cleans up in a `finally` block regardless of outcome — the throwaway
user, its role row, and its grant are all removed, and the auth user is
deleted last since the RBAC rows cascade from it. Run it manually, not as
part of `npm test`, since it needs live credentials and a real network round
trip per query:

```bash
npm run verify:rls
```

Requires `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local`, and at least two rows in
`sites` — the script needs a granted site and an ungranted one to prove a
boundary exists, rather than merely observing an empty table. Every line
prints `PASS` or `FAIL`; the process exits non-zero if any assertion fails.
**If assertion 2 or 3 ever passes rows through, stop and treat it as an
active cross-tenant leak** — that is the exact failure this phase exists to
prevent, not a test to adjust.

## Known exposures

One thing this phase does **not** close, recorded here explicitly so it is
tracked as open work, not silently assumed closed by the RLS rewrite. A
second, related exposure — `admin_users` inside `site_snapshots.payload` —
is being addressed in phase 9b (see below), but is not fully closed yet:
`0011` and `0013`, below, are both still unapplied to the live database.

1. `site_snapshots.payload` contains every WordPress administrator's login
   and email, readable by any client with a grant on that site over
   PostgREST (RLS is row-level and cannot filter inside a JSONB column).
   **This closes only after all three of the following have happened, in
   this order — no single one of them closes it alone:**

   1. **`0011_site_admin_users.sql` applied.** Creates the staff-only
      `site_admin_users` table and its RLS policy, and strips
      `payload.admin_users` from every `site_snapshots` row that exists at
      the moment it runs. It does **not** stop new leakage: the
      still-deployed old `collectInventory` keeps writing
      `payload.admin_users` on every refresh until the code below ships,
      and `site_snapshots` is insert-only history (`insertSnapshot` in
      `src/services/inventory/repo.ts` never updates a row after the fact,
      and multiple rows per site are kept) — so those new rows accumulate
      rather than getting overwritten.
   2. **This branch's code deployed.** `collectInventory` pulls
      `admin_users` off the raw MCP response before it ever reaches the
      `InventoryPayload` written to `site_snapshots.payload`. This is the
      step that actually stops new writes; `0011` alone does not.
   3. **`0013_snapshot_no_admin_users.sql` applied.** Re-runs the same strip
      as `0011` — this time to clean up whatever the old collector wrote
      into new rows during the gap between steps 1 and 2 — then adds the
      `site_snapshots_no_admin_users` check constraint as a permanent,
      database-level backstop. The strip must run again here because
      `alter table ... add constraint` with no `not valid` clause validates
      every existing row, and the gap rows from step 1's window would
      otherwise abort the migration.

   An on-call engineer must not read "`0011` applied" and conclude the leak
   is closed — it isn't, until step 2 has also shipped and step 3 has also
   run. Right now, in production, none of the three have happened: every
   historical `site_snapshots` row still carries `payload.admin_users`, and
   any client holding a grant on that site can still read it out.

   Once all three steps above are complete, WordPress administrator
   identities live in their own table, `site_admin_users` (one row per
   site, replaced wholesale on each inventory refresh), with its own RLS
   policy, `site_admin_users_read`, granting `select` to holders of
   `sites.view_all` only. The `site_snapshots_no_admin_users` check
   constraint added in step 3 then stands permanently, so a revert of the
   application code fails loudly at write time instead of silently
   re-publishing admin logins to every client with a grant. The site
   overview page's Administrators card reads `site_admin_users` gated on
   `can(viewer, "sites.view_all")`, the same permission the RLS policy
   checks, rather than on role, so the UI and the database state the same
   rule.

2. **A `client`-role user with a `manage`-level site grant can trigger
   `refreshInventoryAction`.** That action requires site access at `manage`
   specifically because it opens an MCP connection and runs PHP against the
   live WordPress site (see spec §4.3) — it is not a read despite looking
   like one. The brief for `client` accounts is read-only access and report
   generation; nothing in the schema or the RLS policies stops an operator
   from granting a `client` a `manage`-level row in `user_site_access`
   instead of `read`. Doing so silently hands that client the ability to run
   PHP on the customer's site through `refreshInventoryAction`, bypassing
   the intended read-only boundary. Until this is enforced in code (e.g.
   rejecting `manage` grants for `client`-role users at grant time), **client
   grants must always be created at `read`, never `manage`** — this is an
   operational rule, not something the database currently prevents.
