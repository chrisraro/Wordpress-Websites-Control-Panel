# Authorization (roles, permissions, site grants, user management)

Spec: `docs/superpowers/specs/2026-08-29-phase9a-authorization-design.md` (roles,
permissions, RLS) and `docs/superpowers/specs/2026-08-29-phase9b-user-management-design.md`
(invitations, lockout guards, the two exposure closures below).

## The migration ledger

| Migration | Status | Applies |
|---|---|---|
| `0006_rbac_schema.sql` | Applied | Roles, `role_permissions`, `user_permission_overrides`, `user_site_access`. |
| `0007_rbac_functions.sql` | Applied | `authorize()`, `authorize_for_user()`, `has_site_access()`. |
| `0008_rls_scoped.sql` | Applied | Row-level security for the client-scoped read path. |
| `0009_rbac_write_scope.sql` | Applied | Closes the write-policy gap `0008` left (see below). |
| `0010_vuln_write_permission.sql` | **Pending** | Corrects one permission mapping in `0009`. |
| `0011_site_admin_users.sql` | **Pending** | Moves WordPress admin identities to a staff-only table. Apply **before** deploying this branch. |
| `0012_revoke_site_credential_columns.sql` | **Pending** | Revokes `mcp_endpoint`/`wp_username`/`app_password_encrypted` from `authenticated`. Apply **after** deploying this branch. |
| `0013_snapshot_no_admin_users.sql` | **Pending** | Permanent check-constraint backstop for `0011`. Apply **after** deploying this branch. |
| `0014_require_one_admin.sql` | **Pending** | Row-level `AFTER UPDATE OR DELETE` trigger backstop against the last-admin race two concurrent demotions can cause (see its header). No ordering dependency on `0010`–`0013` or this branch's deploy — safe to apply any time. |

**As of this writing, only `0006`–`0009` are applied to the live database.**
`0010`, `0011`, `0012`, `0013` and `0014` are all still pending. Do not read
any narrower claim elsewhere in this repo's history as still true — this
table is the current state.

`0009` corrects a gap in `0008`'s write policies (see "Read vs. manage" below).
`0010` fixes one permission mapping in `0009`: `site_vulnerabilities` writes
require `security.run`, not `wp_toolkit.manage`, because the security scan
(`syncSiteVulns`, reached only through `runSecurityScanAction`) is the only
thing that writes them. `0010` has no ordering dependency on this branch's
deploy — it is safe to apply on its own, any time.

### The ordered runbook for `0011`–`0013`

```
apply 0011  →  deploy this branch's code  →  apply 0012 and 0013 (either order)  →  npm run verify:rls
```

Each step exists because of a specific, verified failure mode if the order is
broken:

1. **Apply `0011` before deploying.** The code on this branch reads
   `site_admin_users` unconditionally for any viewer holding `sites.view_all`
   (`latestAdminUsers` in `src/services/inventory/repo.ts`, called from the
   site overview page). Deploy first and that read throws on a missing
   relation — 500ing the site overview page for every staff viewer, not just
   degrading gracefully.

2. **Deploy this branch's code.** This is what actually stops new leakage:
   `collectInventory` (`src/services/inventory/service.ts`) destructures
   `admin_users` off the raw MCP response before it ever reaches the
   `InventoryPayload` written to `site_snapshots.payload`, and
   `SITE_COLUMNS` (`src/services/sites/repo.ts`) drops `mcp_endpoint` and
   `wp_username`, reading them instead through the new staff-only
   `getSiteConnection()`. `0011` alone does not stop new leakage — see
   "Known exposures" below.

3. **Apply `0012` only after the deploy.** PostgREST fails the *whole* query
   when a select list names a column `authenticated` has no privilege on —
   not just that column. Apply `0012` before the deploy and every client
   page that reads `sites` (`/dashboard`, `/sites/[id]` and all six of its
   tabs, `/marketplace`, `/marketplace/themes`) starts 500ing the moment the
   still-deployed old code's `SITE_COLUMNS` selects `mcp_endpoint` or
   `wp_username`. There is no hazard running the deploy without `0012` first
   — the code change only narrows what it selects, so it is harmless (if
   incomplete) to deploy before the revoke lands.

   `0012`'s own header carries a second warning worth repeating here: this
   migration used to be a column-level revoke
   (`revoke select (mcp_endpoint, wp_username, app_password_encrypted) on
   sites from authenticated`), and that form is a **silent no-op**.
   `authenticated` already holds Supabase's default table-level
   `grant select` on every `public` table, and per PostgreSQL's own REVOKE
   documentation, revoking a privilege from individual columns has no effect
   when the same privilege is already held at the table level — column
   grants are additive on top of table grants, never subtractive from them.
   The old form would have warned (`WARNING: no privileges could be revoked
   for column ...`), committed anyway, and been recorded as applied while a
   client with a grant kept reading all three columns unchanged. The current
   version instead revokes the table-level grant outright and re-grants only
   the safe column subset, in the same transaction, in that order — see
   "Known exposures" §2 below for what this actually closes.

4. **Apply `0013` only after the deploy.** Until the code that stops writing
   `admin_users` into the payload is live, the still-deployed old
   `collectInventory` writes that key on *every* refresh. `0013` adds
   `check (not (payload ? 'admin_users'))` on `site_snapshots` with no
   `not valid` clause, which makes Postgres validate every existing row
   before the constraint is allowed to exist at all. Land it before the
   deploy and it rejects every one of those writes — every
   `refreshInventoryAction`, every `snapshot_refresh` job, and every
   `security_scan` that falls back to `refreshSnapshot` because it found no
   cached snapshot (all of them, on a cold site) — with a check-constraint
   violation. `0013` also re-runs `0011`'s payload strip immediately before
   adding the constraint, under a `lock table site_snapshots in share row
   exclusive mode`, specifically to clean up whatever the old collector wrote
   into *new* rows during the gap between step 1 and step 2 —
   `site_snapshots` is insert-only history (`insertSnapshot` in
   `src/services/inventory/repo.ts` never updates a row after the fact), so
   those gap rows are never touched by `0011`'s own strip and would
   otherwise abort `0013`'s `add constraint` on the very database it is
   written for.

   **Rollback of `0013`**, mirroring `0012`'s rollback above, is:

   ```sql
   alter table site_snapshots drop constraint site_snapshots_no_admin_users;
   ```

   Reverting the code half of this deploy (the `collectInventory` change that
   stops writing `admin_users` into the payload) while `0013` stays applied
   makes every `refreshInventoryAction`, every `snapshot_refresh` job, and
   every cold-site `security_scan` fail with a check-constraint violation —
   the old collector still writes `payload.admin_users` and the constraint
   rejects it outright. That failure is the intended, desirable behaviour
   (see "Known exposures" §1 below: it fails loudly at write time instead of
   silently re-publishing admin logins), **not a bug to route around** —
   dropping the constraint is an incident-recovery measure to restore write
   availability during an emergency code rollback, not a fix. Running the
   statement above re-opens exactly the exposure `0011`/`0013` closed: any
   client with a grant on a site can once again read that site's WordPress
   administrator logins and emails out of `site_snapshots.payload` over
   PostgREST, for every new row written while the constraint stays dropped.
   Re-apply the `add constraint` statement from `0013` the moment the
   reverted code (or a fixed forward deploy) stops writing `admin_users`
   again, and treat the constraint-dropped window as a reportable exposure,
   not a resolved incident.

5. **Run `npm run verify:rls`.** See the section below — it is the only
   check that proves any of this against the live database rather than
   against a mock.

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
  grants, without inventing a role just for them. There is deliberately no
  UI for this — see "Per-user overrides stay SQL-only" below.
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

## Changing a role or a site grant by SQL

Use the Supabase SQL editor (or `psql`) directly for anything the `/users` UI
doesn't cover (role and per-site grants themselves are now managed through
`/users` — see "Invitations" and the guard table below; this section remains
for direct database access). Find the user's id first:

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

## Invitations

`/users` invites through `inviteUserAction`
(`src/app/(dashboard)/users/actions.ts`), which calls
`supabase.auth.admin.generateLink({ type: "invite", email, options: {
redirectTo } })` — **not** `inviteUserByEmail`. Measured against this
project: `inviteUserByEmail` creates the account but its returned user has
`action_link: undefined`, so there is no link to show. `generateLink` creates
the same account *and* returns `properties.action_link`
(`src/services/users/repo.ts`). Since the whole point of showing a link is to
survive an email that never arrives, the API that cannot produce one is the
wrong tool.

Whether Supabase's built-in mailer actually sends anything depends on the
project's SMTP configuration — it is rate-limited to a handful per hour and
is frequently spam-filtered even when configured. The UI does not assume it
worked: it presents the returned link as the thing to send, and treats any
email Supabase does manage to deliver as a bonus, not the mechanism.

**The invite link is a bearer credential.** Anyone holding it can claim that
account — no password is ever set by anyone but the recipient. The dialog
shows it once, to the administrator who just created the account
(`src/app/(dashboard)/users/invite-dialog.tsx`), with a copy-to-clipboard
control, and it is never stored or logged anywhere in this codebase. Treat it
exactly like a password reset link: send it somewhere only the recipient can
read.

**`APP_URL` is a required prerequisite for a usable invite in any deployed
environment**, not merely an n8n/GeoGrid setting (see `.env.example`).
`inviteUserAction` builds `redirectTo` as `` `${APP_URL}/login` ``, falling
back to `http://localhost:3000` when `APP_URL` is unset. Deploy without
setting it and every invite link `generateLink` returns points at
localhost — the invite dialog shows a link, the administrator sends it, and
it is unusable by the recipient, with nothing failing loudly anywhere in
this flow to surface the mistake. Separately, `redirectTo` must also appear
in Supabase Auth's redirect URL allow-list (Authentication > URL
Configuration in the Supabase dashboard) — `generateLink` rejects a
`redirectTo` that is not on that list regardless of what `APP_URL` is set
to, so both the environment variable and the dashboard setting have to be
correct together.

**A `client` must be granted at least one site at invite time.** A client
with no grants has an empty dashboard and can do nothing, so creating one
that way is a way to manufacture a confusing account. Both the form and the
server action enforce this — the action re-checks because it is a `"use
server"` export and therefore a publicly invokable endpoint regardless of
what the UI shows.

Order of operations inside `inviteUserAction`, and why: the account is
created first, then the role row, then any site grants. A role or grant
failure after the account exists must not leave a roleless account that can
sign in and see nothing with no explanation — that is worse than no account
at all. So if the role insert (or any site grant) fails, the action deletes
the just-created auth user (`rollbackFailedInvite`, not the guarded
`deleteManagedUser` — by the time a grant fails, the role may already have
committed `admin` onto this brand-new account, and if that makes it the sole
admin, the lockout guard would refuse to remove it; that refusal must
surface, not be swallowed) before returning the error to the administrator.

## The self-lockout guards

The `/users` and `/users/roles` matrix editor is powerful enough to
permanently brick administration of this app, and the only recovery from
that is raw SQL against production. `src/services/users/guards.ts` enforces
these as **hard refusals**, not warnings — a warning you can click through is
how you end up in the SQL editor on a Friday:

| Operation | Rule |
|---|---|
| Remove `users.manage` from `admin` | **Refused.** This is the one that makes the editor unable to repair itself. |
| Demote the last `admin` | **Refused.** |
| Delete the last `admin` | **Refused.** |
| Delete your own account | **Refused.** Ask another admin. |
| Demote yourself while another admin exists | Allowed, with a confirmation naming the consequence. One-way door from your side. |

Every guard is enforced in the **server action**
(`src/app/(dashboard)/users/actions.ts`, via `src/services/users/guards.ts`),
not the UI. The UI additionally disables the control and states the reason,
because a disabled control with a reason is better than an error after the
click — but the refusal that matters is the server's, since every one of
these actions is reachable directly regardless of what any page renders.

"Last admin" is counted at the moment of the write, against `user_roles`
(`isSoleAdmin` counts distinct admin ids currently in the table), not against
whatever the page had rendered when the operator loaded it.

**`users.manage` is self-elevating by design.** Nothing stops someone holding
`users.manage` from granting themselves `admin`, or granting `users.manage`
to any role they like through the permission matrix editor. This permission
*is* the authority to change every other authorization fact in the system,
including who holds it — treat it with the same care as direct database
access, because it is functionally equivalent to it.

## Per-user overrides stay SQL-only

`user_permission_overrides` exists (`0006_rbac_schema.sql`) and `getViewer()`
honours it — a `deny` override strips a permission the role would otherwise
grant, an `allow` override adds one the role doesn't, and `deny` is applied
after `allow` so it always wins (`src/lib/authz/server.ts`). There is
**deliberately no UI** for this table, in this phase or any phase before it.

Add one:

```sql
insert into user_permission_overrides (user_id, permission, effect, granted_by)
values ('<user-id>', 'wp_toolkit.manage', 'deny', '<admin-user-id>')
on conflict (user_id, permission) do update set effect = excluded.effect, granted_by = excluded.granted_by;
```

Remove one:

```sql
delete from user_permission_overrides where user_id = '<user-id>' and permission = 'wp_toolkit.manage';
```

Why no UI: an override is a *second*, subtler way to grant (or take away)
access, independent of role and independent of the `/users/roles` matrix
that is supposed to be the one legible source of "what can this role do".
An `allow` override in particular is a silent, per-person exception to that
matrix — exactly the kind of grant an audit of "who can do X" would miss if
it only read `role_permissions`. Giving it a UI would make it easy to reach
for casually; it stays in the SQL editor so that using it is deliberately a
little harder than the normal path, and so that whoever adds one has to
write down, at minimum, who they are and why, in the query itself. It would
need its own audit trail and its own review story before it earns a UI, and
neither exists yet.

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
creates two throwaway Supabase Auth users — a `client` with a single `read`
grant on one site, and a `content_writer` with **no** `user_site_access` rows
at all (staff see every site through `sites.view_all` and need no grant) —
signs in as each with the anon key, and runs **thirteen** assertions as those
real, RLS-governed sessions:

1. `select` on `sites` returns exactly the granted site.
2. `select` on `sites` filtered to the *other* site returns zero rows.
3. `select` on `site_snapshots` for the other site returns zero rows.
4. `update` on the granted site is rejected (a `read` grant is not `manage`).
5. `insert` into `site_snapshots` for the granted site is rejected (same
   read/manage split, on a child table).
6. `select` on `jobs` returns zero rows (`jobs` is staff-only, gated on
   `sites.view_all`, which `client` never holds).
7. `select` on `site_admin_users` for the granted site returns zero rows
   (Phase 9b §5.1 / `0011`) — a client's own read/manage grant on a site
   grants nothing here; the policy gates on `sites.view_all` alone.
8. `select sites.mcp_endpoint` for the granted site is rejected (Phase 9b
   §5.2 / `0012`), preceded by a positive control that selects every column
   `0012` grants, read out of the migration file itself — without that
   control, a refusal on `mcp_endpoint` could pass vacuously in a world
   where `0012`'s revoke landed without its paired grant, which denies every
   column on `sites` and 500s every client page.
9. **(content_writer)** `select` on `sites` returns *every* site
   (`sites.view_all` working at all — without this, every "refused"
   assertion below it could pass vacuously because the session was never
   valid).
10. **(content_writer)** cannot null out a report's `share_token` — the
    headline case `0009` fixes.
11. **(content_writer)** cannot delete a `security_checks` row.
12. **(content_writer)** cannot insert a forged `site_snapshots` row.
13. **(content_writer)** cannot insert into `seo_snapshots` even though the
    role holds `seo.run` — holding the permission alone is not enough without
    a manage-level site grant, which this fixture deliberately never gets.

**A line can print `PASS`, `FAIL`, or `UNVERIFIED`.** `UNVERIFIED` is neither
a pass nor a failure — it means a prerequisite the assertion depends on could
not be established (in practice, today, this is assertion 7 failing to seed
against `site_admin_users` because `0011` has not been applied yet), so the
query that would prove or disprove the assertion never ran. The script
deliberately does not count an `UNVERIFIED` line as a pass — that would be
exactly the vacuous check this script exists to avoid, a green result for the
wrong reason — and does not count it as a failure either, because an
unmigrated database is a different condition than a regression. It still
forces a non-zero exit code: **never read `UNVERIFIED` as verified, and never
treat the process exit code alone as "clean" without reading which of the
three every line printed.**

It cleans up in a `finally` block regardless of outcome: both throwaway
users, their role rows, their grants, and any fixture or probe rows the
script seeded (including a `site_admin_users` row, once `0011` exists) are
all removed, and each auth user is deleted last since the RBAC rows cascade
from it. **This script creates throwaway auth users and mutates RBAC and
inventory tables in whatever database its environment variables point at —
never run it against a database you cannot afford to have temporarily
touched.** It is deliberately not part of `npm test`, since it needs live
credentials and a real network round trip per query:

```bash
npm run verify:rls
```

Requires `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local`, and at least two rows in
`sites` — the script needs a granted site and an ungranted one to prove a
boundary exists, rather than merely observing an empty table.
**If assertion 2 or 3 ever passes rows through, stop and treat it as an
active cross-tenant leak** — that is the exact failure this phase exists to
prevent, not a test to adjust.

This document does not claim any of the thirteen assertions have been run
against the live database as part of writing it — that verification is the
operator's step, after applying the pending migrations above, not something
a documentation change can assert on their behalf.

## Known exposures

Two exposures were identified and are being closed in Phase 9b. **As of this
writing, neither is closed**, because every migration either one depends on
is still pending (see the migration ledger at the top of this document). An
on-call engineer must not read "the code for this shipped" and conclude an
exposure is closed — closure is a database state, not a code state, for both
of these.

1. **`site_snapshots.payload.admin_users`** — every WordPress administrator's
   login and email, readable by any client with a grant on that site over
   PostgREST. RLS is row-level and cannot filter inside a JSONB column, so
   hiding the Administrators card in the UI was always cosmetic, not access
   control.

   **Closes only after all three of the following have happened, in this
   order — no single one of them closes it alone:**

   1. **`0011_site_admin_users.sql` applied.** Creates the staff-only
      `site_admin_users` table and its RLS policy
      (`site_admin_users_read`, gated on `sites.view_all` alone), and
      strips `payload.admin_users` from every `site_snapshots` row that
      exists at the moment it runs. It does **not** stop new leakage: the
      still-deployed old `collectInventory` keeps writing
      `payload.admin_users` on every refresh until the code below ships,
      and `site_snapshots` is insert-only history, so those new rows
      accumulate rather than getting overwritten.
   2. **This branch's code deployed.** `collectInventory` pulls
      `admin_users` off the raw MCP response before it ever reaches the
      `InventoryPayload` written to `site_snapshots.payload`. This is the
      step that actually stops new writes; `0011` alone does not.
   3. **`0013_snapshot_no_admin_users.sql` applied.** Re-runs the same strip
      as `0011` — this time to clean up whatever the old collector wrote
      into new rows during the gap between steps 1 and 2 — then adds the
      `site_snapshots_no_admin_users` check constraint as a permanent,
      database-level backstop.

   **Current state: none of the three have happened.** Every historical
   `site_snapshots` row still carries `payload.admin_users`, and any client
   holding a grant on that site can still read it out over PostgREST today.

   Once all three steps are complete, WordPress administrator identities
   live in their own table, gated by RLS to holders of `sites.view_all`
   only, and the check constraint stands permanently — so a future revert of
   the application code fails loudly at write time instead of silently
   re-publishing admin logins to every client with a grant.

2. **`mcp_endpoint`, `wp_username` and `app_password_encrypted` on `sites`**
   — readable by any client with a grant, over PostgREST, regardless of what
   the UI renders, because RLS is row-level and cannot hide a column from a
   row a client is otherwise allowed to read. `0009_rbac_write_scope.sql`
   promised this write-up ("see the accompanying report... for what a real
   fix requires") and never delivered it; this is that write-up.

   Of the three columns: `wp_username` is genuinely non-derivable from
   anything else `sites` exposes, and `app_password_encrypted` is the
   encrypted WordPress application password — both matter for
   confidentiality on their own terms. `mcp_endpoint` is **not** a secret by
   construction — `mcpEndpointFor(url)` is simply
   `url.replace(/\/+$/, "") + "/wp-json/mcp/novamira"`, and `url` itself
   stays readable by any client with a grant — so revoking it is
   defence-in-depth and column-set consistency, not confidentiality. Do not
   treat this exposure as ever having included a real information
   disclosure for `mcp_endpoint` specifically; there was very little to
   close there.

   **Closes only once `0012_revoke_site_credential_columns.sql` is
   applied**, and only if it is applied *after* this branch's code is
   deployed (see the runbook above — applying it first 500s every client
   page instead). `0012` cannot be a column-level revoke: `authenticated`
   already holds Supabase's default table-level `grant select` on `sites`,
   and column privileges are additive on top of table privileges, never
   subtractive from them, so a column-level revoke against an existing
   table-level grant is a silent no-op — Postgres warns, commits, and the
   migration is recorded as applied while every column stays readable
   unchanged. `0012` instead revokes the table-level grant outright and
   re-grants exactly the safe column subset
   (`id, name, url, status, client_label, capabilities, created_at,
   updated_at`) in the same transaction. **Current state: `0012` is
   unapplied, so `authenticated` still holds the original blanket
   table-level grant and all three columns remain readable by any client
   with a site grant.**

3. **A `client`-role user with a `manage`-level site grant can trigger
   `refreshInventoryAction`.** That action requires site access at `manage`
   specifically because it opens an MCP connection and runs PHP against the
   live WordPress site (spec §4.3) — it is not a read despite looking like
   one. The brief for `client` accounts is read-only access and report
   generation; nothing in the schema or the RLS policies stops an operator
   from granting a `client` a `manage`-level row in `user_site_access`
   instead of `read`. Doing so silently hands that client the ability to run
   PHP on the customer's site, bypassing the intended read-only boundary.
   Until this is enforced in code (e.g. rejecting `manage` grants for
   `client`-role users at grant time), **client grants must always be
   created at `read`, never `manage`** — this is an operational rule, not
   something the database or the `/users` invite flow currently prevents.
   (The invite flow's own site grants are hardcoded to `read` — see
   "Invitations" above — so this risk is specifically about grants made
   through `grantSiteAction` or direct SQL after the fact, not through
   invitation.)
