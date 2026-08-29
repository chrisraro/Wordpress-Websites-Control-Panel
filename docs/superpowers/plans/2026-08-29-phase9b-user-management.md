# Phase 9b — User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An administrator can invite people, set roles, grant sites, and edit the permission matrix from the panel. Then close the two exposures Phase 9a left open.

**Architecture:** Every new surface reuses 9a's split — pages call `require*` (404 on refusal), server actions call `check*` (return a denial). The lockout guards are pure functions so every branch is table-testable, and are enforced in the server action, never only in the UI.

**Tech Stack:** Next.js 15.5.24 (App Router, Server Actions), React 19.2.8, TypeScript strict, Supabase (Postgres + Auth admin API), Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-29-phase9b-user-management-design.md`. Read it first. §4 (lockout guards) and §5 (the exposures) are the parts where mistakes are expensive.
- **Every exported function in a `"use server"` module is a public HTTP endpoint**, whether or not the UI calls it. Each gets its own `checkPermission("users.manage")`.
- **Lockout guards are hard refusals, enforced server-side.** The UI may also disable a control and explain why, but the refusal that matters is the server's. "Last admin" is counted at the moment of the write, against `user_roles`, never against what a page rendered.
- **404, never 403** for a page the caller may not see.
- Pages use `require*`; actions use `check*`. Never `notFound()` inside an action.
- **No `as unknown as` casts on server actions.** There are zero and it must stay that way.
- Client Components receive plain serialisable values — never the `Viewer`, whose `Set` and `Map` do not cross the RSC boundary.
- Design system is `DESIGN.md` via `src/components/ui/styles.ts`; detector must return `[]` on changed UI:
  `node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json <files>`
- Responsive to 375px, no horizontal overflow.
- TypeScript strict; `npx tsc --noEmit` clean; `npm run build` clean; `npm test` green (currently 342 passing).
- **Migration 0012 must not be applied until Task 9's code is deployed.** Revoking those columns first makes every client page 500.

---

### Task 1: Lockout guards (pure)

The one piece of logic here that can permanently brick administration.

**Files:**
- Create: `src/services/users/types.ts`
- Create: `src/services/users/guards.ts`
- Test: `tests/user-guards.test.ts`

**Interfaces:**
- Produces:
  - `interface ManagedUser { id: string; email: string | null; role: AppRole | null; lastSignInAt: string | null; invitedNotAccepted: boolean; siteGrants: number }`
    `role` is nullable because an account can exist in `auth.users` with no `user_roles` row — `getViewer` denies it everything, and the directory must show it rather than hide it. A null-role user is never the last admin and may always be deleted.
  - `type GuardVerdict = { allowed: true } | { allowed: false; reason: string }`
  - `canChangeRole(users: ManagedUser[], targetId: string, next: AppRole): GuardVerdict` — takes no actor: demoting yourself is allowed whenever another admin exists, so the rule does not depend on who is asking. The UI still needs to know it is a self-demote, to confirm; that is a call-site concern.
  - `canDeleteUser(users: ManagedUser[], actorId: string, targetId: string): GuardVerdict`
  - `canSetRolePermission(role: AppRole, permission: AppPermission, enabled: boolean): GuardVerdict`
  Consumed by Tasks 3, 5 and 6.

- [ ] **Step 1: Write the failing test**

Create `tests/user-guards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canChangeRole, canDeleteUser, canSetRolePermission } from "@/services/users/guards";
import type { ManagedUser } from "@/services/users/types";
import type { AppRole } from "@/lib/authz/types";

const user = (id: string, role: AppRole | null): ManagedUser => ({
  id, email: `${id}@example.com`, role,
  lastSignInAt: null, invitedNotAccepted: false, siteGrants: 0,
});

const ONE_ADMIN = [user("a1", "admin"), user("d1", "developer")];
const TWO_ADMINS = [user("a1", "admin"), user("a2", "admin"), user("d1", "developer")];

describe("canChangeRole", () => {
  it("refuses demoting the last admin", () => {
    const v = canChangeRole(ONE_ADMIN, "a1", "developer");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/last admin/i);
  });

  it("allows demoting yourself when another admin exists", () => {
    expect(canChangeRole(TWO_ADMINS, "a1", "developer")).toEqual({ allowed: true });
  });

  it("allows demoting another admin when one remains", () => {
    expect(canChangeRole(TWO_ADMINS, "a2", "client")).toEqual({ allowed: true });
  });

  it("allows promoting someone to admin", () => {
    expect(canChangeRole(ONE_ADMIN, "d1", "admin")).toEqual({ allowed: true });
  });

  it("refuses a target that is not in the list", () => {
    expect(canChangeRole(ONE_ADMIN, "ghost", "admin").allowed).toBe(false);
  });

  it("is a no-op verdict when the role is unchanged", () => {
    // Changing admin -> admin must not trip the last-admin rule.
    expect(canChangeRole(ONE_ADMIN, "a1", "admin")).toEqual({ allowed: true });
  });
});

describe("canDeleteUser", () => {
  it("refuses deleting yourself, even with other admins around", () => {
    const v = canDeleteUser(TWO_ADMINS, "a1", "a1");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/your own/i);
  });

  it("refuses deleting the last admin", () => {
    const v = canDeleteUser(ONE_ADMIN, "d1", "a1");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/last admin/i);
  });

  it("allows deleting a non-admin", () => {
    expect(canDeleteUser(ONE_ADMIN, "a1", "d1")).toEqual({ allowed: true });
  });

  it("refuses a target that is not in the list", () => {
    expect(canDeleteUser(ONE_ADMIN, "a1", "ghost").allowed).toBe(false);
  });

  it("allows deleting an account that has no role at all", () => {
    // A user can exist in auth.users with no user_roles row. They are denied
    // everything and are never the last admin, so removing them is always safe.
    const withRoleless = [...ONE_ADMIN, user("r1", null)];
    expect(canDeleteUser(withRoleless, "a1", "r1")).toEqual({ allowed: true });
  });
});

describe("canSetRolePermission", () => {
  it("refuses removing users.manage from admin", () => {
    // This is the one that makes the matrix editor unable to repair itself.
    const v = canSetRolePermission("admin", "users.manage", false);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/repair|lock/i);
  });

  it("allows granting users.manage to admin", () => {
    expect(canSetRolePermission("admin", "users.manage", true)).toEqual({ allowed: true });
  });

  it("allows removing users.manage from a non-admin role", () => {
    expect(canSetRolePermission("developer", "users.manage", false)).toEqual({ allowed: true });
  });

  it("allows removing any other permission from admin", () => {
    expect(canSetRolePermission("admin", "seo.run", false)).toEqual({ allowed: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/user-guards.test.ts`
Expected: FAIL — `Cannot find module '@/services/users/guards'`.

- [ ] **Step 3: Write the types**

Create `src/services/users/types.ts` with `ManagedUser` and `GuardVerdict` as in the Interfaces block, plus:

```ts
export const ALLOWED: GuardVerdict = { allowed: true };
export const refuse = (reason: string): GuardVerdict => ({ allowed: false, reason });
```

- [ ] **Step 4: Write the guards**

Create `src/services/users/guards.ts`. Reasons are shown verbatim to the user, so write complete sentences.

```ts
/**
 * These refuse operations that would leave the panel unadministrable. Recovery
 * from any of them means raw SQL against production, so each is a hard refusal
 * rather than a warning — and each is enforced in the server action, not only
 * by hiding a control.
 */
export function canChangeRole(
  users: ManagedUser[], targetId: string, next: AppRole,
): GuardVerdict {
  const target = users.find((u) => u.id === targetId);
  if (!target) return refuse("That account no longer exists.");
  if (target.role === next) return ALLOWED;

  const admins = users.filter((u) => u.role === "admin");
  if (target.role === "admin" && admins.length <= 1) {
    return refuse("This is the last administrator. Promote someone else first.");
  }
  return ALLOWED;
}

export function canDeleteUser(
  users: ManagedUser[], actorId: string, targetId: string,
): GuardVerdict {
  const target = users.find((u) => u.id === targetId);
  if (!target) return refuse("That account no longer exists.");
  // Deleting yourself is refused outright, not just when you are the last
  // admin: signing yourself out of the product permanently should go through
  // someone else.
  if (targetId === actorId) return refuse("You cannot delete your own account.");

  const admins = users.filter((u) => u.role === "admin");
  if (target.role === "admin" && admins.length <= 1) {
    return refuse("This is the last administrator. Promote someone else first.");
  }
  return ALLOWED;
}

export function canSetRolePermission(
  role: AppRole, permission: AppPermission, enabled: boolean,
): GuardVerdict {
  if (role === "admin" && permission === "users.manage" && !enabled) {
    return refuse(
      "Administrators must keep Manage users, or nobody could repair this matrix again.",
    );
  }
  return ALLOWED;
}
```

- [ ] **Step 5: Run the tests and commit**

```bash
npm test && npx tsc --noEmit
git add src/services/users tests/user-guards.test.ts
git commit -m "feat(users): lockout guards for role, deletion and the permission matrix"
```

---

### Task 2: Users repo and service

**Files:**
- Create: `src/services/users/repo.ts`
- Create: `src/services/users/service.ts`
- Test: `tests/users-service.test.ts`

**Interfaces:**
- Consumes: `ManagedUser` (Task 1), `AppRole`/`AppPermission`/`SiteAccessLevel` from `@/lib/authz/types`.
- Produces:
  - `interface UsersRepo` with `listUsers()`, `getUser(id)`, `setRole(userId, role, grantedBy)`, `deleteUser(id)`, `listGrants(userId)`, `grantSite(userId, siteId, level, grantedBy)`, `revokeSite(userId, siteId)`, `listRolePermissions()`, `setRolePermission(role, permission, enabled)`, `inviteUser(email, redirectTo)`
  - `supabaseUsersRepo(db): UsersRepo`
  Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

`listUsers` joins three sources — `auth.users` via the admin API, `user_roles`, and a grant count. Test that composition with an in-memory fake, following the fake style already used in `tests/bulk-service.test.ts`.

Cover: a user with no `user_roles` row is still listed (with a role of `null` so the UI can show "no role — cannot sign in"); the grant count is per user; `invitedNotAccepted` is true when `last_sign_in_at` is null.

`ManagedUser.role` is already `AppRole | null` from Task 1 — do not narrow it. A user with no `user_roles` row is a real state the directory must surface.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/users-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the repo**

Create `src/services/users/repo.ts`. It takes the service-role client — the Supabase auth admin API requires it, and this whole surface is staff-only.

`listUsers` must page `listUsers({ page, perPage })` until a short page comes back, the same way `scripts/bootstrap-admin.ts` does. A directory that silently stops at 50 accounts is a bug that only appears once you have 51.

`inviteUser` returns both the created user and the action link when Supabase provides one, so the UI can show a copyable fallback:

```ts
inviteUser(email: string, redirectTo: string): Promise<{ id: string; inviteLink: string | null }>;
```

**Use `auth.admin.generateLink({ type: "invite", email, options: { redirectTo } })`, not `inviteUserByEmail`.** Measured on this project: `inviteUserByEmail` returns a user whose `action_link` is `undefined`, so there is no link to show; `generateLink` creates the same account and returns `properties.action_link`. The link is a bearer credential — return it, never log it.

```ts
```

- [ ] **Step 4: Write the service**

`src/services/users/service.ts` composes repo calls into the operations the actions need, and is where the guards are applied — so an action cannot forget one:

```ts
export async function changeUserRole(
  repo: UsersRepo, actorId: string, targetId: string, next: AppRole,
): Promise<{ ok: boolean; error?: string }> {
  const users = await repo.listUsers();
  const verdict = canChangeRole(users, targetId, next);
  if (!verdict.allowed) return { ok: false, error: verdict.reason };
  await repo.setRole(targetId, next, actorId);
  return { ok: true };
}
```

`deleteManagedUser` and `setRolePermissionChecked` follow the same shape. The guard is evaluated against a **freshly read** list, never against anything the caller passed in.

- [ ] **Step 5: Run the tests and commit**

```bash
npm test && npx tsc --noEmit
git add src/services/users tests/users-service.test.ts
git commit -m "feat(users): directory repo and guard-enforcing service"
```

---

### Task 3: Server actions

**Files:**
- Create: `src/app/(dashboard)/users/actions.ts`
- Test: `tests/authz-actions-users.test.ts`

**Interfaces:**
- Produces, all `(…args, prevState?, formData?)` shaped and all returning `{ ok: boolean; error?: string }` unless noted:
  - `inviteUserAction(prevState, formData)` → also `{ inviteLink?: string | null }`
  - `setUserRoleAction(userId, role, prevState?, formData?)`
  - `deleteUserAction(userId, prevState?, formData?)`
  - `grantSiteAction(userId, siteId, level, prevState?, formData?)`
  - `revokeSiteAction(userId, siteId, prevState?, formData?)`
  - `setRolePermissionAction(role, permission, enabled, prevState?, formData?)`

- [ ] **Step 1: Write the failing tests**

Mock `@/lib/authz/server` and make the mocked service throw if reached, so an ignored guard fails loudly. Assert for **every** action that it refuses without `users.manage` — six tests, one per exported function, because each is its own public endpoint.

Then assert the lockout paths reach the caller as denials rather than throwing: demoting the last admin, deleting yourself, and unchecking `users.manage` for `admin`.

Then the invite rules:
- an invite with role `client` and no site ids is refused
- when the role insert fails, `deleteUser` is called on the just-created auth user

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/authz-actions-users.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the actions**

Every one starts with the same two lines:

```ts
const user = await requireUser();
const gate = await checkPermission("users.manage");
if (isDenied(gate)) return gate;
```

`inviteUserAction` reads `email`, `role` and `siteIds` from the form, validates with zod (the codebase already uses it in `sites/new/actions.ts`), refuses a `client` with no sites, then:

```ts
// Order matters: a user with no role row is denied everything by getViewer(),
// so a half-created account can sign in and see nothing with no explanation.
const invited = await repo.inviteUser(email, `${appUrl}/login`);
try {
  await repo.setRole(invited.id, role, user.id);
  for (const siteId of siteIds) await repo.grantSite(invited.id, siteId, "read", user.id);
} catch (e) {
  await repo.deleteUser(invited.id);
  return { ok: false, error: "Could not finish creating the account — nothing was kept." };
}
return { ok: true, inviteLink: invited.inviteLink };
```

Every action calls `revalidatePath("/users")`, and the per-user ones also `revalidatePath(\`/users/${userId}\`)`.

- [ ] **Step 4: Verify and commit**

```bash
npm test && npx tsc --noEmit && npm run build
git add "src/app/(dashboard)/users" tests/authz-actions-users.test.ts
git commit -m "feat(users): server actions for invite, role, grants and the matrix"
```

---

### Task 4: `/users` — the directory and invite dialog

**Files:**
- Create: `src/app/(dashboard)/users/page.tsx`
- Create: `src/app/(dashboard)/users/invite-dialog.tsx`
- Modify: `src/app/(dashboard)/layout.tsx`, `src/components/shell/sidebar.tsx`

- [ ] **Step 1: The page**

Server Component. First line: `await requirePermission("users.manage");`. Reads through `createServiceSupabase()` — the auth admin API requires it and this surface is staff-only.

A table: email, role badge, sites granted, last sign-in, status. A person who has never signed in shows an "Invited" badge. A person with **no role** shows a `bad`-toned badge reading "No role — cannot sign in", because that state exists and is invisible otherwise.

Use `StatusBadge` from `@/components/ui/primitives` and the table classes from `@/components/ui/styles`, matching the plugins table.

- [ ] **Step 2: The invite dialog**

Client Component using the existing `Modal` from `@/components/ui/modal`. Fields: email, role (select), and a site multi-select that appears **only** when role is `client` and is then required.

On success the dialog stays open and shows the invite link with a `CopyValueButton` (already exists in `src/components/ui/copy-button.tsx`), plus one line explaining that the emailed invite may be slow or filtered and this link works either way. It closes on dismiss, not automatically — closing it would throw away the link.

- [ ] **Step 3: The sidebar item**

`layout.tsx` passes `showUsers={can(viewer, "users.manage")}`; `Sidebar` renders a "Users" nav item when true, following exactly how `showMarketplace` already works. Plain boolean across the boundary.

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit && npm test && npm run build
node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json "src/app/(dashboard)/users" src/components/shell/sidebar.tsx
git commit -m "feat(users): directory page, invite dialog and sidebar entry"
```

---

### Task 5: `/users/[id]` — one person

**Files:**
- Create: `src/app/(dashboard)/users/[id]/page.tsx`
- Create: `src/app/(dashboard)/users/[id]/role-form.tsx`
- Create: `src/app/(dashboard)/users/[id]/site-grants.tsx`

- [ ] **Step 1: The page**

`await requirePermission("users.manage")`, then load the person, their grants, and the full site list. 404 if the id is unknown.

- [ ] **Step 2: Role control**

A select plus a save button, wired to `setUserRoleAction`. Demoting yourself opens a `ConfirmDialog` naming the consequence ("You will lose access to user management immediately"). The control is disabled with a visible reason when the guard would refuse — compute that on the server with `canChangeRole(users, targetId, next)` and pass a plain `{ allowed, reason }` across the boundary.

- [ ] **Step 3: Site grants**

List current grants with their level and a remove control. An add control: pick a site, pick read or manage.

Above it, for a **staff** role, a note that grants are unnecessary because staff reach every site through `sites.view_all` — and next to a `manage` grant on a `client`, a warning that manage-level lets them trigger inventory refreshes, which opens an MCP connection and runs PHP on the live site. Both facts come from spec §4.3 and are invisible otherwise.

- [ ] **Step 4: Delete account**

A `danger` `ManageForm` with a confirm dialog. Disabled with its reason when `canDeleteUser` refuses.

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit && npm test && npm run build
node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json "src/app/(dashboard)/users"
```
Expected: typecheck clean, tests green, build clean, detector `[]`. Then:

```bash
git commit -m "feat(users): per-user role, site grants and deletion"
```

---

### Task 6: `/users/roles` — the permission matrix

**Files:**
- Create: `src/app/(dashboard)/users/roles/page.tsx`
- Create: `src/app/(dashboard)/users/roles/matrix.tsx`

- [ ] **Step 1: The page**

`await requirePermission("users.manage")`, load `role_permissions`, render the matrix.

- [ ] **Step 2: The matrix**

Client Component. Ten rows (permissions) × four columns (roles) of checkboxes. Each row carries a one-line description of what that permission actually gates — take the text from the enum comments in `supabase/migrations/0006_rbac_schema.sql` so the UI and the schema agree.

Each toggle calls `setRolePermissionAction` in a transition and toasts the outcome. The `admin` × `users.manage` checkbox is rendered **checked and disabled**, with a title explaining that removing it would leave nobody able to repair the matrix.

Above the table, two sentences: that changes take effect on the affected users' next request, and that `users.manage` is self-elevating — anyone holding it can make themselves an administrator.

At 375px the matrix must scroll inside its own `overflow-x-auto` container rather than the page.

- [ ] **Step 3: Verify and commit**

```bash
npx tsc --noEmit && npm test && npm run build
node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json "src/app/(dashboard)/users"
```
Expected: typecheck clean, tests green, build clean, detector `[]`. Then:

```bash
git commit -m "feat(users): editable role permission matrix"
```

---

### Task 7: Move WordPress administrator identities out of the snapshot

Closes spec §5.1. RLS cannot filter inside a JSONB column, so the data moves.

**Files:**
- Create: `supabase/migrations/0011_site_admin_users.sql`
- Modify: `src/services/inventory/types.ts`, `src/services/inventory/service.ts`, `src/services/inventory/repo.ts`
- Modify: `src/app/(dashboard)/sites/[id]/page.tsx`
- Test: `tests/inventory-admin-users.test.ts`

- [ ] **Step 1: Write the failing test**

Assert `INVENTORY_PHP` no longer puts `admin_users` in the returned payload, that the collector returns the admin list separately, and that the migration strips the key from existing rows.

- [ ] **Step 2: The migration**

`0011_site_admin_users.sql`, exactly as spec §5.1 — the table, RLS enabled, the staff-only read policy, **and** the payload strip:

```sql
update site_snapshots set payload = payload - 'admin_users' where payload ? 'admin_users';
```

Without that line every already-scanned site keeps the data readable and the fix is cosmetic.

- [ ] **Step 3: Split the collector**

`INVENTORY_PHP` keeps gathering `$admins` but returns it under a separate top-level key, not inside the inventory payload. `collectInventory` returns `{ payload, adminUsers }`; `refreshSnapshot` writes the payload to `site_snapshots` and upserts `site_admin_users` in the same pass.

Remove `admin_users` from `InventoryPayload`. The compiler then finds every reader — which is the point.

- [ ] **Step 4: Read it back on the overview**

The Administrators card reads from the new table via a repo method, still inside the existing `!isClient` branch.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npx tsc --noEmit && npm run build
git commit -m "feat(inventory): move WP administrator identities to a staff-only table"
```

- [ ] **Step 6: Apply migration 0011**

Run it in the Supabase SQL editor, then refresh a site's inventory and confirm the Administrators card still renders for an admin.

---

### Task 8: Narrow the site columns

Closes spec §5.2's code half. **Migration 0012 is written here but applied in Task 10, after this code is deployed** — reversing that order 500s every client page.

**Files:**
- Modify: `src/services/sites/types.ts`, `src/services/sites/repo.ts`
- Modify: `src/app/(dashboard)/sites/[id]/page.tsx`
- Create: `supabase/migrations/0012_revoke_site_credential_columns.sql`
- Test: `tests/sites-repo-columns.test.ts`

- [ ] **Step 1: Write the failing test**

Assert `SITE_COLUMNS` contains neither `mcp_endpoint` nor `wp_username`, and that `getSiteConnection` selects exactly those two.

- [ ] **Step 2: Narrow the type and the select**

Remove `mcp_endpoint` and `wp_username` from `SiteRow` and from `SITE_COLUMNS`. Add:

```ts
getSiteConnection(id: string): Promise<{ mcp_endpoint: string; wp_username: string } | null>;
```

Leaving them on the type while dropping them from the select would make every consumer type-check against values that are `undefined` at runtime.

- [ ] **Step 3: Fix the readers the compiler finds**

The site overview's Connection card is the only display consumer; it calls `getSiteConnection` inside the existing `!isClient` branch, on the service-role client.

- [ ] **Step 4: Write migration 0012 — do not apply it**

```sql
-- Apply only AFTER the code that stops selecting these columns is deployed.
-- PostgREST fails the whole query when a revoked column appears in a select
-- list, so applying this first makes every client page 500.
revoke select (mcp_endpoint, wp_username, app_password_encrypted) on sites from authenticated;
```

- [ ] **Step 5: Verify and commit**

```bash
npm test && npx tsc --noEmit && npm run build
git commit -m "feat(sites): keep credential-adjacent columns off the shared read path"
```

---

### Task 9: Extend the live RLS verification

**Files:**
- Modify: `scripts/verify-rls.ts`

- [ ] **Step 1: Add assertions for both exposures**

In the existing client section, after the current assertions:
- the client **cannot** read `site_admin_users` for their granted site (seed a row first so zero-rows is not vacuous)
- the client **cannot** select `mcp_endpoint` from the site they *are* granted — this one errors rather than returning empty, since the column grant is revoked, so use the existing `isRlsRefusal` shape but accept the "permission denied for column" signature too, and say in a comment why this one differs

Both must fail against the pre-migration state. State in your report how you confirmed that.

- [ ] **Step 2: Commit**

```bash
git commit -m "test(authz): verify both closed exposures against the live database"
```

---

### Task 10: Live verification and documentation

**Files:**
- Modify: `docs/ops/authorization.md`
- Modify: `README.md`

- [ ] **Step 1: Apply migration 0012**

Only now, with Task 8's code deployed. Then immediately load a page as the admin to confirm nothing broke.

- [ ] **Step 2: Run the full verification**

```bash
npm run verify:rls
```
Every assertion must pass, including the two new ones.

- [ ] **Step 3: Invite a real account end to end**

Invite a throwaway address as a `client` granted one site. Confirm: the invite link appears in the UI; accepting it lets them set a password; they land on a dashboard showing only that site; every action control is absent; report generation works; `mcp_endpoint` and `wp_username` appear nowhere. Then delete the account from `/users` and confirm it is gone.

- [ ] **Step 4: Verify the lockout guards on the live app**

As the only admin: confirm the role select refuses to demote you, the delete control is disabled with a reason, and the `admin` × `users.manage` checkbox is checked and disabled.

- [ ] **Step 5: Update the docs**

`docs/ops/authorization.md`: replace the "Known exposures" section with what actually closed and how; document the invite flow and the fallback link; document the lockout guards; note that per-user overrides remain SQL-only and how to set one; record that migrations 0011 and 0012 are applied and that 0012 has a deployment-order dependency.

- [ ] **Step 6: Commit**

```bash
git commit -m "docs: user management operations and closed exposures"
```

---

## Definition of done

- `npx tsc --noEmit` clean, `npm run build` clean, `npm test` green with no fewer than 342 tests.
- Detector `[]` on every changed UI file; no horizontal overflow at 375px.
- Migrations 0011 and 0012 applied, in that order, with 0012 after Task 8's deploy.
- `npm run verify:rls` passes every assertion including the two new ones.
- A real invited client account was created, used, and deleted through the UI.
- The lockout guards were confirmed on the live app, not only in tests.
