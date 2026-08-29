# Phase 9b — User Management (Design)

**Date:** 2026-08-29
**Status:** Approved for planning
**Depends on:** Phase 9a (merged). Migrations 0006–0010 applied.

## Goal

Let an administrator run the panel's accounts from the panel: invite people, set their role, grant them sites, and edit what each role may do. Then close the two exposures Phase 9a deliberately left open, because this phase is what makes client accounts routine.

## Non-goals

- **Custom roles.** The four roles are fixed. What each role *may do* is editable; inventing a fifth is a migration.
- **A UI for per-user permission overrides.** `user_permission_overrides` exists and `getViewer` honours it, but it is a second, subtler way to grant access and would need its own audit story. It stays SQL-only, documented in `docs/ops/authorization.md`.
- **Changing anyone's authorization semantics.** 9a decided who may do what; this phase only gives that model a UI and moves two pieces of data out of reach.

---

## 1. Verified current state

Measured on 2026-08-29, after migration 0010:

| | |
|---|---|
| `npm run verify:rls` | 11/11 against the live database |
| Auth users | 1 — `rarochristian029@gmail.com`, role `admin` |
| Sites | 2 |
| RBAC tables | `user_roles`, `role_permissions` (23 seeded rows), `user_permission_overrides` (empty), `user_site_access` (empty) |
| `admin_users` | produced in one place (`INVENTORY_PHP`), consumed in one place (site overview) |
| `SITE_COLUMNS` | selects `mcp_endpoint` and `wp_username`; used by `listSites` and `getSite` |

---

## 2. Surfaces

All under `/users`, gated on `users.manage`, and shown in the sidebar only to those who hold it — the same `require*` / `can()` split 9a established.

### 2.1 `/users` — the people list

One row per account: email, role, number of sites granted, last sign-in, and whether the invite is still unaccepted. Actions: invite (opens a dialog), and a link into each person's detail page.

`last_sign_in_at` comes from `auth.users` via the admin API, which is service-role only — so this page reads through the service-role client and is gated in application code, matching how every other staff surface works.

### 2.2 `/users/[id]` — one person

Their role, with a control to change it. Their site grants, with add and remove, and a read/manage level per grant. A delete-account action.

**Site grants are only meaningful for a `client`.** Staff reach every site through `sites.view_all`, so a grant adds nothing. The UI says so rather than offering a control that does nothing, and grants are still *shown* for staff if any exist, because a leftover row from an earlier role would otherwise be invisible.

### 2.3 `/users/roles` — the permission matrix

Ten permissions × four roles as checkboxes, writing `role_permissions`. Each row is one permission with a one-line description of what it actually gates, taken from the enum comments in `0006_rbac_schema.sql`, so an admin is not guessing what `wp_toolkit.manage` covers.

Changes take effect on the affected users' **next request** — 9a reads role, permissions and grants per request rather than from the JWT, precisely so revocation is immediate. The page says so.

**A note the UI must carry, next to `users.manage`:** that permission is inherently self-elevating. Anyone holding it can grant themselves `admin`. That is what the permission means, not a defect, but nobody should discover it by accident.

---

## 3. Invitations

`supabase.auth.admin.generateLink({ type: "invite", email, options: { redirectTo } })`
from a server action, then the role row, then any site grants — in that order, so a
failure never leaves a user with no role, which 9a treats as no access at all.

**`generateLink`, not `inviteUserByEmail`** — measured against this project on
2026-08-29. `inviteUserByEmail` creates the account but its returned user has
`action_link: undefined`, so there is no link to show. `generateLink` creates the
same account *and* returns `properties.action_link`. Since the whole point of
showing a link is to survive an email that never arrives, the API that cannot
produce one is the wrong tool. Whether Supabase also emails the link depends on
the project's SMTP configuration, so the UI presents the link as the thing to
send and treats any email as a bonus rather than the mechanism.

**The invite link is returned to the UI and shown with a copy control.** Supabase's
built-in mailer is rate-limited to a handful per hour and is frequently
spam-filtered; without a visible link, a throttled invite is a dead end with no
recovery path in the product. No password is ever set by anyone but the recipient.

The link is a bearer credential — anyone holding it can claim that account. It is
shown once, to the administrator who just created the account, and never stored
or logged.

**A `client` must be granted at least one site at invite time.** A client with no grants has an empty dashboard and can do nothing, so creating one is a way to manufacture a confusing account. The form requires it; the server action re-checks.

If the invite succeeds but the role insert fails, the action deletes the just-created auth user before returning the error. A half-created account is worse than none: it can sign in, has no role, and is denied everything with no explanation.

---

## 4. Self-lockout guards

The matrix editor is powerful enough to permanently brick administration, and the only recovery is raw SQL against production. These are **hard refusals**, not warnings — a warning you can click through is how you end up in the SQL editor on a Friday.

| Operation | Rule |
|---|---|
| Remove `users.manage` from `admin` | **Refused.** This is the one that makes the editor unable to repair itself. |
| Demote the last `admin` | **Refused.** |
| Delete the last `admin` | **Refused.** |
| Delete your own account | **Refused.** Ask another admin. |
| Demote yourself while another admin exists | Allowed, with a confirmation naming the consequence. One-way door from your side. |

Every guard is enforced in the **server action**, not the UI. The UI additionally disables the control and says why, because a disabled control with a reason is better than an error after the click — but the refusal that matters is the server's.

"Last admin" is counted at the moment of the write, against `user_roles`, not against what the page rendered.

---

## 5. Closing the two exposures

### 5.1 WordPress administrator identities

A client granted a site can read that site's `site_snapshots` row, and `payload.admin_users` contains every WordPress administrator's login and email. The overview page already hides the card; RLS is row-level and **cannot filter inside a JSONB column**, so the data has to move rather than be masked.

`admin_users` moves out of `InventoryPayload` into its own table:

```sql
create table site_admin_users (
  site_id    uuid not null references sites(id) on delete cascade,
  collected_at timestamptz not null default now(),
  users      jsonb not null,
  primary key (site_id)
);
alter table site_admin_users enable row level security;

create policy site_admin_users_read on site_admin_users
  for select to authenticated
  using ( (select authorize('sites.view_all')) );
```

Staff-only, and written exclusively by the service-role collector. One row per site, replaced on each inventory refresh — the history has no value and keeping it would multiply the exposure surface.

**Old snapshots keep their `admin_users` key.** The field becomes optional on the type and is no longer read from the payload; a client can still read *historical* snapshot rows that contain it until those age out. The migration therefore also strips the key from existing rows:

```sql
update site_snapshots set payload = payload - 'admin_users' where payload ? 'admin_users';
```

Without that line the fix is cosmetic for every site already scanned, which is all of them.

### 5.2 Credential-adjacent columns on `sites`

`SITE_COLUMNS` selects `mcp_endpoint` and `wp_username`, and a client's page reads go through the user-scoped client, so a client can `select` them over PostgREST. Revoking the columns alone would break every client page, because PostgREST fails the **whole query** when a revoked column appears in the select list.

So both halves are needed:

1. `SITE_COLUMNS` drops `mcp_endpoint` and `wp_username`. A new repo method returns them for the one staff surface that displays them:

   ```ts
   getSiteConnection(id: string): Promise<{ mcp_endpoint: string; wp_username: string } | null>
   ```

   called from the site overview inside the existing `!isClient` branch, on the service-role client.

2. Then the revoke is safe:

   ```sql
   revoke select (mcp_endpoint, wp_username, app_password_encrypted) on sites from authenticated;
   ```

**`SiteRow` must lose the fields too.** Dropping them from the select while the
type still declares them as `string` leaves every consumer type-checking against
values that are `undefined` at runtime — the same silent lie that
`as unknown as` casts caused in an earlier phase. `mcp_endpoint` and
`wp_username` come off `SiteRow`; the compiler then finds every reader, which is
the point. `getSiteConnection`'s return type is where they live now.

`getSiteCredentials` is unchanged — it names the columns explicitly and only ever runs on the service-role client, which is unaffected by a grant revoked from `authenticated`.

**Order matters.** The code change ships before the revoke, or every client page 500s between the two.

---

## 6. Data model

No new RBAC tables. `site_admin_users` (§5.1) is the only addition. Migrations:

- `0011_site_admin_users.sql` — the table, its policy, and the payload strip.
- `0012_revoke_site_credential_columns.sql` — the column revoke, applied **after** the code in §5.2 is deployed.

Two migrations rather than one, because they are safe to apply at different times and the second has a deployment order dependency the first does not.

---

## 7. Enforcement

Every new surface follows 9a's pattern exactly:

| Surface | Guard |
|---|---|
| `/users`, `/users/[id]`, `/users/roles` | `requirePermission("users.manage")` — 404 otherwise |
| `inviteUserAction`, `setUserRoleAction`, `deleteUserAction` | `checkPermission("users.manage")` + the §4 guards |
| `grantSiteAction`, `revokeSiteAction` | `checkPermission("users.manage")` |
| `setRolePermissionAction` | `checkPermission("users.manage")` + the §4 guards |

Every one of those actions is an exported function in a `"use server"` module and therefore a public endpoint in its own right, whether or not the UI calls it.

The sidebar gains a "Users" item shown only when `can(viewer, "users.manage")`, passed as a plain boolean, matching how `showConnectSite` and `showMarketplace` already cross the RSC boundary.

---

## 8. Testing

Vitest with in-memory fakes, the existing pattern. 342 tests pass today and must still pass.

- **The §4 guards are the priority**, as pure functions over a user list so every branch is table-testable: last admin, self-delete, self-demote with and without another admin, and stripping `users.manage` from `admin`.
- **Each action refuses without `users.manage`** — one test per action, the same shape as `tests/authz-actions-*.test.ts`.
- **The invite's failure path**: a role-insert failure deletes the auth user rather than leaving a roleless account.
- **A client must be granted a site at invite time** — refused otherwise.
- **`scripts/verify-rls.ts` gains assertions for §5**: a client cannot read `site_admin_users`, and cannot select `mcp_endpoint` from a site they *are* granted. Both must fail against the pre-migration state, or they prove nothing.
- **Live verification before merge**: invite a real throwaway address, confirm the link works, accept it, confirm the account lands with the right role and grants, then delete it.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| An admin bricks administration via the matrix | §4 guards, server-enforced, unit-tested per branch |
| A half-created account that can sign in but has no role | Invite action deletes the auth user if the role insert fails |
| The column revoke lands before the code and 500s every client page | §5.2 states the order; the two changes are separate migrations |
| The `admin_users` fix is cosmetic because old rows still carry the key | The migration strips the key from existing payloads |
| Invite emails throttled or spam-filtered | The link is shown in the UI with a copy control |
| `users.manage` is self-elevating and surprises someone | Stated in the UI beside the permission, and in the ops doc |
