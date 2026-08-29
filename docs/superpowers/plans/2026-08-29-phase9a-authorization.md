# Phase 9a — Authorization Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four roles, an editable permission matrix, per-site grants, and enforcement on all 39 surfaces (20 server actions, 12 pages, 2 route handlers). At the end the app is secure and `rarochristian029@gmail.com` is the administrator.

**Architecture:** Authorization rules are defined once as Postgres `security definer` functions, called both by RLS policies and by the application over RPC. Staff keep the service-role client with an explicit check in every action; clients read through a user-scoped client so Postgres itself enforces site scoping. Role, permissions and grants are read per request (never from the JWT) so revocation is immediate.

**Tech Stack:** Next.js 15.5.24 (App Router, Server Actions), React 19.2.8, TypeScript strict, Supabase (Postgres + Auth), Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-29-phase9a-authorization-design.md`. Read it before starting. §4.3 is the enforcement map and is the definitive checklist.
- **Deploy order is a safety requirement.** `authorize()` returns false when a user has no `user_roles` row. Migration + bootstrap script must be applied **before** enforcement code reaches production, or the only admin is locked out. Tasks 1–3 exist for exactly this reason and must not be reordered after Task 4.
- **Every exported function in a `"use server"` module is a public HTTP endpoint**, whether or not a component imports it. Exported helpers get their own check. Never rely on "nothing calls it from the client".
- **Middleware performs no authorization** (Next.js CVE-2025-29927). Every page, action and handler re-checks independently.
- **404, never 403,** for a site the caller may not see — a 403 confirms it exists.
- **`set search_path = ''` on every `security definer` function**, with every object reference schema-qualified.
- **No RLS policy may call a helper that reads the table the policy protects.** `user_site_access`'s self-read uses a bare `auth.uid()` predicate.
- **Wrap helper calls in policies as `(select authorize(...))`** so Postgres evaluates them once per statement, not once per row.
- TypeScript strict; `npx tsc --noEmit` clean; `npm run build` clean; `npm test` green (currently 237 passing).
- UI work follows `DESIGN.md` via `src/components/ui/styles.ts`; the detector must return `[]` on changed UI files:
  `node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json <files>`
- **Do not change what any existing feature does.** This phase adds gates, not behaviour.

---

### Task 1: Schema — roles, permissions, grants, default matrix

**Files:**
- Create: `supabase/migrations/0006_rbac_schema.sql`
- Create: `src/lib/authz/types.ts`
- Test: `tests/authz-schema.test.ts`

**Interfaces:**
- Produces:
  - `type AppRole = "admin" | "developer" | "content_writer" | "client"`
  - `type AppPermission` — the ten permission strings
  - `APP_ROLES: readonly AppRole[]`, `APP_PERMISSIONS: readonly AppPermission[]`
  - `DEFAULT_MATRIX: Record<AppRole, readonly AppPermission[]>`
  - `type SiteAccessLevel = "read" | "manage"`
  Consumed by every later task.

- [ ] **Step 1: Write the failing test**

The real risk here is the TypeScript union and the SQL enum drifting apart — a permission that exists in one and not the other fails silently at runtime. Test the migration text against the constants.

Create `tests/authz-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { APP_PERMISSIONS, APP_ROLES, DEFAULT_MATRIX } from "@/lib/authz/types";

const SQL = readFileSync("supabase/migrations/0006_rbac_schema.sql", "utf8");

describe("SQL enums match the TypeScript unions", () => {
  it("declares every role, and no others", () => {
    const m = SQL.match(/create type app_role as enum \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const inSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(inSql.sort()).toEqual([...APP_ROLES].sort());
  });

  it("declares every permission, and no others", () => {
    const m = SQL.match(/create type app_permission as enum \(([\s\S]*?)\);/);
    expect(m).not.toBeNull();
    const inSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(inSql.sort()).toEqual([...APP_PERMISSIONS].sort());
  });
});

describe("DEFAULT_MATRIX matches the seeded rows", () => {
  it("seeds exactly the pairs the matrix declares", () => {
    const seeded = [...SQL.matchAll(/\('(\w+)',\s*'([\w.]+)'\)/g)].map(([, r, p]) => `${r}:${p}`);
    const declared = APP_ROLES.flatMap((r) => DEFAULT_MATRIX[r].map((p) => `${r}:${p}`));
    expect(seeded.sort()).toEqual(declared.sort());
  });

  it("gives client exactly one permission — reports.generate", () => {
    expect(DEFAULT_MATRIX.client).toEqual(["reports.generate"]);
  });

  it("gives admin every permission", () => {
    expect([...DEFAULT_MATRIX.admin].sort()).toEqual([...APP_PERMISSIONS].sort());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/authz-schema.test.ts`
Expected: FAIL — `Cannot find module '@/lib/authz/types'`.

- [ ] **Step 3: Write the TypeScript types**

Create `src/lib/authz/types.ts`:

```ts
/**
 * The authorization vocabulary. These unions mirror the Postgres enums in
 * supabase/migrations/0006_rbac_schema.sql exactly; tests/authz-schema.test.ts
 * fails if the two drift, because a permission that exists on one side only
 * fails silently at runtime.
 */
export const APP_ROLES = ["admin", "developer", "content_writer", "client"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const APP_PERMISSIONS = [
  "sites.view_all",
  "sites.manage",
  "wp_toolkit.manage",
  "security.run",
  "seo.run",
  "geogrid.manage",
  "reports.generate",
  "reports.manage",
  "queue.process",
  "users.manage",
] as const;
export type AppPermission = (typeof APP_PERMISSIONS)[number];

export type SiteAccessLevel = "read" | "manage";
export type OverrideEffect = "allow" | "deny";

/** Seeded once; an admin edits role_permissions afterwards (Phase 9b). */
export const DEFAULT_MATRIX: Record<AppRole, readonly AppPermission[]> = {
  admin: [...APP_PERMISSIONS],
  developer: [
    "sites.view_all", "wp_toolkit.manage", "security.run", "seo.run",
    "geogrid.manage", "reports.generate", "reports.manage", "queue.process",
  ],
  content_writer: ["sites.view_all", "seo.run", "geogrid.manage", "reports.generate"],
  // A client's reach comes from their site grants, not from permissions.
  client: ["reports.generate"],
};
```

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0006_rbac_schema.sql` with, in order: the four enums (`app_role`, `app_permission`, `override_effect`, `site_access_level`), the four tables (`user_roles`, `role_permissions`, `user_permission_overrides`, `user_site_access`) exactly as specified in spec §2, the `user_site_access (user_id)` index, and the default-matrix seed as a single `insert ... values ... on conflict do nothing`.

Write the seed pairs as `('role', 'permission')` tuples on their own lines so the drift test can parse them.

Do **not** add RLS policies here — Task 8 owns that. Adding them now would have no effect (all code still uses service-role) but would make Task 8's diff harder to review.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, including the 237 pre-existing.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0006_rbac_schema.sql src/lib/authz tests/authz-schema.test.ts
git commit -m "feat(authz): roles, permissions, grants schema and default matrix"
```

---

### Task 2: Postgres authorization functions

**Files:**
- Create: `supabase/migrations/0007_rbac_functions.sql`
- Test: `tests/authz-functions.test.ts`

**Interfaces:**
- Produces four SQL functions: `authorize(app_permission)`, `authorize_for_user(uuid, app_permission)`, `has_site_access(uuid, site_access_level)`, `has_site_access_for_user(uuid, uuid, site_access_level)`. The `_for_user` variants are executable only by `service_role`. Consumed by Tasks 4 and 8.

- [ ] **Step 1: Write the failing test**

The dangerous mistakes here are structural and greppable. Create `tests/authz-functions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SQL = readFileSync("supabase/migrations/0007_rbac_functions.sql", "utf8");
const FUNCS = ["authorize", "authorize_for_user", "has_site_access", "has_site_access_for_user"];

describe("authorization functions", () => {
  it("defines all four", () => {
    for (const f of FUNCS) {
      expect(SQL).toMatch(new RegExp(`create or replace function public\\.${f}\\(`));
    }
  });

  it("pins search_path on every security definer function", () => {
    // Without this a lower-privileged caller can shadow an unqualified
    // identifier and change what the function resolves to.
    const definers = SQL.match(/security definer/g) ?? [];
    const pinned = SQL.match(/set search_path = ''/g) ?? [];
    expect(definers.length).toBeGreaterThan(0);
    expect(pinned.length).toBe(definers.length);
  });

  it("schema-qualifies every table reference", () => {
    for (const t of ["user_roles", "role_permissions", "user_permission_overrides", "user_site_access"]) {
      const bare = new RegExp(`from\\s+${t}\\b`, "g");
      expect(SQL.match(bare)).toBeNull();
      expect(SQL).toMatch(new RegExp(`public\\.${t}\\b`));
    }
  });

  it("restricts the _for_user variants to service_role", () => {
    for (const f of ["authorize_for_user", "has_site_access_for_user"]) {
      expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${f}[\\s\\S]*?from`));
      expect(SQL).toMatch(new RegExp(`grant execute on function public\\.${f}[\\s\\S]*?to service_role`));
    }
  });

  it("lets an override deny a permission the role grants", () => {
    // The override must be consulted BEFORE role_permissions, or a deny is
    // silently ignored for any permission the role already allows.
    const body = SQL.slice(SQL.indexOf("function public.authorize("));
    expect(body.indexOf("user_permission_overrides")).toBeLessThan(body.indexOf("role_permissions"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/authz-functions.test.ts`
Expected: FAIL — the migration file does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0007_rbac_functions.sql`. Use spec §3's `authorize` verbatim as the starting point, then add the other three.

`has_site_access` returns true when the caller holds `sites.view_all`, or has a row in `user_site_access` for that site whose level satisfies the minimum:

```sql
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
```

The `_for_user` variants take the id explicitly, because the application's staff path runs on the service-role client where `auth.uid()` is null. Same rules, same order — a divergence between the two is a security bug.

Finish with the grants:

```sql
revoke all on function public.authorize_for_user(uuid, public.app_permission) from public, anon, authenticated;
grant execute on function public.authorize_for_user(uuid, public.app_permission) to service_role;
revoke all on function public.has_site_access_for_user(uuid, uuid, public.site_access_level) from public, anon, authenticated;
grant execute on function public.has_site_access_for_user(uuid, uuid, public.site_access_level) to service_role;
```

- [ ] **Step 4: Run the tests and commit**

```bash
npm test
git add supabase/migrations/0007_rbac_functions.sql tests/authz-functions.test.ts
git commit -m "feat(authz): postgres authorization functions"
```

- [ ] **Step 5: Apply migrations 0006 and 0007**

Run both in the Supabase SQL editor, in order. **Everything after this task assumes they are applied.**

---

### Task 3: Bootstrap the first administrator

Runs before any enforcement exists, so the only account is already an admin when the gates land. Getting this out of order locks the owner out of their own panel.

**Files:**
- Create: `scripts/bootstrap-admin.ts`
- Modify: `package.json` (a `bootstrap:admin` script)

- [ ] **Step 1: Write the script**

Create `scripts/bootstrap-admin.ts`. It must be idempotent — safe to re-run — and must never set a password:

```ts
/**
 * Promote one account to admin. Run once per environment:
 *   BOOTSTRAP_ADMIN_EMAIL=someone@example.com npm run bootstrap:admin
 *
 * Deliberately a script, not a migration: a migration that grants admin runs
 * in every environment forever, which is a backdoor with a friendly name.
 * seed.sql is not an option either — it never runs against a linked project.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
if (!email) throw new Error("Set BOOTSTRAP_ADMIN_EMAIL");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data: list, error: listErr } = await db.auth.admin.listUsers();
  if (listErr) throw listErr;
  let user = list.users.find((u) => u.email?.toLowerCase() === email!.toLowerCase());

  if (!user) {
    // No password is ever set here — the invite link lets them choose one.
    const { data, error } = await db.auth.admin.inviteUserByEmail(email!, {
      redirectTo: `${process.env.APP_URL ?? "http://localhost:3000"}/login`,
    });
    if (error) throw error;
    user = data.user;
    console.log(`invited ${email}`);
  }

  const { error } = await db
    .from("user_roles")
    .upsert({ user_id: user!.id, role: "admin" }, { onConflict: "user_id" });
  if (error) throw error;

  console.log(`admin: ${email} (${user!.id})`);
}

void main();
```

- [ ] **Step 2: Add the npm script**

In `package.json`, under `scripts`: `"bootstrap:admin": "node --experimental-strip-types scripts/bootstrap-admin.ts"`.
If that flag is unavailable on the installed Node, use `npx tsx scripts/bootstrap-admin.ts` and add `tsx` to devDependencies — check `node --version` first and say which you used in your report.

- [ ] **Step 3: Run it against this deployment**

```bash
BOOTSTRAP_ADMIN_EMAIL=rarochristian029@gmail.com npm run bootstrap:admin
```

Expected: prints `admin: rarochristian029@gmail.com (<uuid>)`. The account already exists, so the invite path is skipped. Re-run it once to confirm idempotency — it must succeed identically.

- [ ] **Step 4: Verify the row**

Query `select user_id, role from user_roles;` — exactly one row, role `admin`.

- [ ] **Step 5: Commit**

```bash
git add scripts/bootstrap-admin.ts package.json
git commit -m "feat(authz): idempotent bootstrap script for the first admin"
```

---

### Task 4: TypeScript authorization layer

**Files:**
- Create: `src/lib/authz/decide.ts`
- Create: `src/lib/authz/server.ts`
- Test: `tests/authz-decide.test.ts`

**Interfaces:**
- Consumes: `AppRole`, `AppPermission`, `SiteAccessLevel` (Task 1).
- Produces:
  - `interface Viewer { id: string; email: string | null; role: AppRole; permissions: Set<AppPermission>; grants: Map<string, SiteAccessLevel> }`
  - pure: `can(viewer, permission): boolean`, `canAccessSite(viewer, siteId, min): boolean`, `visibleSiteIds(viewer, allIds): string[] | "all"`
  - server: `getViewer(): Promise<Viewer | null>` (React-`cache`d), `requireViewer(): Promise<Viewer>`, `requirePermission(p): Promise<Viewer>`, `requireSiteAccess(siteId, min?): Promise<Viewer>`, `denyNotFound(): never`
  Consumed by Tasks 5–10.

- [ ] **Step 1: Write the failing test**

Create `tests/authz-decide.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { can, canAccessSite, visibleSiteIds } from "@/lib/authz/decide";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission, SiteAccessLevel } from "@/lib/authz/types";

const viewer = (
  role: Viewer["role"],
  permissions: AppPermission[],
  grants: Array<[string, SiteAccessLevel]> = [],
): Viewer => ({
  id: "u1", email: "u@example.com", role,
  permissions: new Set(permissions),
  grants: new Map(grants),
});

describe("can", () => {
  it("allows a permission the viewer holds", () => {
    expect(can(viewer("developer", ["seo.run"]), "seo.run")).toBe(true);
  });
  it("refuses one they do not", () => {
    expect(can(viewer("developer", ["seo.run"]), "users.manage")).toBe(false);
  });
  it("refuses everything for a viewer with no permissions", () => {
    expect(can(viewer("client", []), "reports.generate")).toBe(false);
  });
});

describe("canAccessSite", () => {
  it("lets a viewer with sites.view_all reach any site at any level", () => {
    const v = viewer("developer", ["sites.view_all"]);
    expect(canAccessSite(v, "any-site", "read")).toBe(true);
    expect(canAccessSite(v, "any-site", "manage")).toBe(true);
  });

  it("lets a client reach only a granted site", () => {
    const v = viewer("client", ["reports.generate"], [["s1", "read"]]);
    expect(canAccessSite(v, "s1", "read")).toBe(true);
    expect(canAccessSite(v, "s2", "read")).toBe(false);
  });

  it("refuses a read grant where manage is required", () => {
    // This is what stops a client triggering an inventory refresh, which
    // opens an MCP connection and runs PHP on the customer's site.
    const v = viewer("client", ["reports.generate"], [["s1", "read"]]);
    expect(canAccessSite(v, "s1", "manage")).toBe(false);
  });

  it("accepts a manage grant where only read is required", () => {
    const v = viewer("client", [], [["s1", "manage"]]);
    expect(canAccessSite(v, "s1", "read")).toBe(true);
  });
});

describe("visibleSiteIds", () => {
  it("returns \"all\" for a viewer with sites.view_all", () => {
    expect(visibleSiteIds(viewer("admin", ["sites.view_all"]), ["a", "b"])).toBe("all");
  });
  it("returns only granted ids otherwise", () => {
    const v = viewer("client", [], [["b", "read"]]);
    expect(visibleSiteIds(v, ["a", "b", "c"])).toEqual(["b"]);
  });
  it("returns an empty list for a client with no grants", () => {
    expect(visibleSiteIds(viewer("client", []), ["a", "b"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/authz-decide.test.ts`
Expected: FAIL — `Cannot find module '@/lib/authz/decide'`.

- [ ] **Step 3: Write the pure decision module**

Create `src/lib/authz/decide.ts`. It is pure — no imports from Supabase, Next, or anything with I/O — so it can be exhaustively tested. `canAccessSite` returns true when the viewer holds `sites.view_all`, or holds a grant whose level satisfies the minimum (`manage` satisfies both; `read` satisfies only `read`).

- [ ] **Step 4: Write the server helpers**

Create `src/lib/authz/server.ts`:

```ts
import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import type { AppPermission, AppRole, SiteAccessLevel } from "./types";
import { can, canAccessSite, type Viewer } from "./decide";

/**
 * Role, permissions and grants are read per request rather than carried in the
 * JWT, so removing someone's access takes effect on their next request instead
 * of whenever their token happens to refresh. cache() keeps that to one round
 * of queries per render.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const auth = await createServerSupabase();
  const { data } = await auth.auth.getUser();
  if (!data.user) return null;

  const db = createServiceSupabase();
  const [roleRow, overrides, grants] = await Promise.all([
    db.from("user_roles").select("role").eq("user_id", data.user.id).maybeSingle(),
    db.from("user_permission_overrides").select("permission,effect").eq("user_id", data.user.id),
    db.from("user_site_access").select("site_id,access_level").eq("user_id", data.user.id),
  ]);

  // No role row means no access at all — fail closed. This is why the
  // bootstrap script must run before enforcement ships.
  const role = roleRow.data?.role as AppRole | undefined;
  if (!role) return null;

  const { data: rolePerms } = await db
    .from("role_permissions").select("permission").eq("role", role);

  const permissions = new Set<AppPermission>(
    (rolePerms ?? []).map((r) => r.permission as AppPermission),
  );
  for (const o of overrides.data ?? []) {
    if (o.effect === "allow") permissions.add(o.permission as AppPermission);
    else permissions.delete(o.permission as AppPermission);
  }

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    role,
    permissions,
    grants: new Map((grants.data ?? []).map((g) => [g.site_id, g.access_level as SiteAccessLevel])),
  };
});

/** For pages: a viewer who may not see this thing is told it does not exist. */
export function denyNotFound(): never {
  notFound();
}

export async function requireViewer(): Promise<Viewer> {
  const v = await getViewer();
  if (!v) denyNotFound();
  return v;
}

export async function requirePermission(p: AppPermission): Promise<Viewer> {
  const v = await requireViewer();
  if (!can(v, p)) denyNotFound();
  return v;
}

export async function requireSiteAccess(
  siteId: string, min: SiteAccessLevel = "read",
): Promise<Viewer> {
  const v = await requireViewer();
  if (!canAccessSite(v, siteId, min)) denyNotFound();
  return v;
}
```

Also export **action** variants that return a result rather than throwing a Next.js navigation error, because a server action returning `{ok:false}` renders an inline error while `notFound()` inside an action is a poor experience:

```ts
export type Denied = { ok: false; error: string };
const DENIED: Denied = { ok: false, error: "You do not have permission to do that." };

export async function checkPermission(p: AppPermission): Promise<Viewer | Denied> { … }
export async function checkSiteAccess(
  siteId: string, min?: SiteAccessLevel,
): Promise<Viewer | Denied> { … }
export function isDenied(x: unknown): x is Denied { … }
```

Both variants must produce the **same** decision — they differ only in how they report it.

- [ ] **Step 5: Run the tests and commit**

```bash
npm test && npx tsc --noEmit
git add src/lib/authz tests/authz-decide.test.ts
git commit -m "feat(authz): pure decision logic and request-scoped server helpers"
```

---

### Task 5: Enforce — site, toolkit and marketplace actions

**Files (all Modify):**
- `src/app/(dashboard)/sites/new/actions.ts` — `createSite`
- `src/app/(dashboard)/sites/[id]/actions.ts` — `runConnectionTest`, `testConnectionAction`
- `src/app/(dashboard)/sites/[id]/manage-actions.ts` — `manageAction`, `refreshInventoryAction`
- `src/app/(dashboard)/sites/[id]/bulk-actions.ts` — `bulkAction`
- `src/app/(dashboard)/sites/[id]/child-theme-actions.ts` — `createChildThemeAction`
- `src/app/(dashboard)/sites/[id]/themes/theme-actions.ts` — `installThemeAction`, `prepareThemeUploadAction`, `searchWpThemesAction`
- `src/app/(dashboard)/marketplace/actions.ts` — `createInstallBatchAction`, `prepareUploadAction`
- Test: `tests/authz-actions-toolkit.test.ts`

Apply spec §4.3 exactly. Each action gains its check as the **first** thing after `requireUser()`.

- [ ] **Step 1: Write failing tests**

Test the decision, not the plumbing: assert each action refuses when the viewer lacks the permission or the site. Mock `@/lib/authz/server` with `vi.mock` and assert the guarded action returns a denial without reaching its service. Follow the mocking style already in `tests/jobs-handlers.test.ts`.

Cover at minimum:
- `createSite` without `sites.manage` is refused
- `manageAction` without `wp_toolkit.manage` is refused
- `manageAction` with the permission but no site access is refused
- `refreshInventoryAction` with only a **read** grant is refused (spec §4.3 note)
- `runConnectionTest` — the exported *helper* — is refused on its own, not only via its wrapper
- `createInstallBatchAction` with two site ids where **one** is not granted is refused entirely and enqueues nothing

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/authz-actions-toolkit.test.ts`
Expected: FAIL — every action currently succeeds regardless of permission.

- [ ] **Step 3: Add the guards**

Shape for a site-scoped action:

```ts
export async function manageAction(
  siteId: string,
  action: ManageAction,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("wp_toolkit.manage");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId, "manage");
  if (isDenied(site)) return site;
  …
}
```

For `createInstallBatchAction`, check **every** id in the list and reject the whole request if any fails — a partial check is a cross-tenant hole.

`searchWpThemesAction` needs only `requireViewer()`: it proxies a public API and leaks nothing, but an unauthenticated endpoint that makes outbound requests is a small abuse surface.

- [ ] **Step 4: Verify and commit**

```bash
npm test && npx tsc --noEmit && npm run build
git add "src/app/(dashboard)" tests/authz-actions-toolkit.test.ts
git commit -m "feat(authz): gate site, toolkit and marketplace actions"
```

---

### Task 6: Enforce — scan, GeoGrid, report and queue actions

**Files (all Modify):**
- `src/app/(dashboard)/sites/[id]/security-actions.ts` — `runSecurityScanAction` → `security.run`
- `src/app/(dashboard)/sites/[id]/seo-actions.ts` — `runSeoScanAction` → `seo.run`
- `src/app/(dashboard)/sites/[id]/geogrid-actions.ts` — `saveGeoGridConfigAction`, `runGeoGridAction` → `geogrid.manage`
- `src/app/(dashboard)/sites/[id]/reports-actions.ts` — `generateReportAction` → `reports.generate`; `revokeReportAction` → `reports.manage`
- `src/app/(dashboard)/queue-actions.ts` — `processQueueNowAction`, `drainQueueAction` → `queue.process`
- Test: `tests/authz-actions-analytics.test.ts`

All site-scoped actions also require site access. `processQueueNowAction` and `drainQueueAction` are not site-scoped — the queue is global — and **both** need the check, because `processQueueNowAction` is an exported helper and therefore its own endpoint.

`generateReportAction` is the one write a client can perform. It keeps the service-role client (it inserts a row and uploads to a private bucket) and is gated exactly like a staff action.

- [ ] **Step 1: Write the failing tests**

Create `tests/authz-actions-analytics.test.ts`. Mock `@/lib/authz/server` and assert each action refuses before reaching its service. Follow the `vi.mock` style already used in `tests/jobs-handlers.test.ts`.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const deny = { ok: false as const, error: "You do not have permission to do that." };

vi.mock("@/lib/authz/server", () => ({
  checkPermission: vi.fn(),
  checkSiteAccess: vi.fn(),
  isDenied: (x: unknown) => typeof x === "object" && x !== null && (x as { ok?: boolean }).ok === false,
  requireViewer: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", email: "u@example.com" })),
  createServiceSupabase: vi.fn(() => { throw new Error("must not reach the database"); }),
}));

import { checkPermission, checkSiteAccess } from "@/lib/authz/server";
import { runSecurityScanAction } from "@/app/(dashboard)/sites/[id]/security-actions";
import { runSeoScanAction } from "@/app/(dashboard)/sites/[id]/seo-actions";
import { saveGeoGridConfigAction, runGeoGridAction } from "@/app/(dashboard)/sites/[id]/geogrid-actions";
import { generateReportAction, revokeReportAction } from "@/app/(dashboard)/sites/[id]/reports-actions";
import { processQueueNowAction, drainQueueAction } from "@/app/(dashboard)/queue-actions";

const viewer = { id: "u1", email: "u@example.com", role: "developer", permissions: new Set(), grants: new Map() };

beforeEach(() => {
  vi.mocked(checkPermission).mockReset();
  vi.mocked(checkSiteAccess).mockReset();
});

describe("permission gates", () => {
  it.each([
    ["runSecurityScanAction", () => runSecurityScanAction("s1")],
    ["runSeoScanAction", () => runSeoScanAction("s1")],
    ["runGeoGridAction", () => runGeoGridAction("s1")],
    ["revokeReportAction", () => revokeReportAction("s1", "r1")],
    // Both queue entry points: processQueueNowAction is an exported helper and
    // therefore its own public endpoint, not merely an internal function.
    ["processQueueNowAction", () => processQueueNowAction()],
    ["drainQueueAction", () => drainQueueAction("/sites/s1/geogrid")],
  ])("%s refuses without its permission", async (_name, call) => {
    vi.mocked(checkPermission).mockResolvedValue(deny);
    vi.mocked(checkSiteAccess).mockResolvedValue(viewer as never);
    const res = await call();
    expect(res.ok).toBe(false);
  });

  it("each action asks for the permission the spec assigns it", async () => {
    vi.mocked(checkPermission).mockResolvedValue(deny);
    vi.mocked(checkSiteAccess).mockResolvedValue(viewer as never);
    for (const [call, expected] of [
      [() => runSecurityScanAction("s1"), "security.run"],
      [() => runSeoScanAction("s1"), "seo.run"],
      [() => saveGeoGridConfigAction("s1", null, new FormData()), "geogrid.manage"],
      [() => generateReportAction("s1", null, new FormData()), "reports.generate"],
      [() => revokeReportAction("s1", "r1"), "reports.manage"],
      [() => processQueueNowAction(), "queue.process"],
    ] as const) {
      vi.mocked(checkPermission).mockClear();
      await call();
      expect(vi.mocked(checkPermission).mock.calls[0][0]).toBe(expected);
    }
  });
});

describe("site scoping", () => {
  it("refuses a site-scoped action when the permission holds but the site does not", async () => {
    vi.mocked(checkPermission).mockResolvedValue(viewer as never);
    vi.mocked(checkSiteAccess).mockResolvedValue(deny);
    const res = await runSecurityScanAction("s-not-mine");
    expect(res.ok).toBe(false);
  });

  it("does not site-scope the queue actions — the queue is global", async () => {
    vi.mocked(checkPermission).mockResolvedValue(viewer as never);
    vi.mocked(checkSiteAccess).mockResolvedValue(deny);
    await processQueueNowAction();
    expect(vi.mocked(checkSiteAccess)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/authz-actions-analytics.test.ts`
Expected: FAIL — these actions currently run regardless of permission, and the mocked `createServiceSupabase` throws "must not reach the database", proving the guard is absent.

- [ ] **Step 3: Add the guards**

Each action gains its check immediately after `requireUser()`, before any service call. Site-scoped shape:

```ts
export async function runSecurityScanAction(
  siteId: string,
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const gate = await checkPermission("security.run");
  if (isDenied(gate)) return gate;
  const site = await checkSiteAccess(siteId);
  if (isDenied(site)) return site;
  // ... existing body unchanged
}
```

Queue shape — no site scope, because the queue is global:

```ts
export async function processQueueNowAction(
  revalidate?: string,
): Promise<{ ok: boolean; done?: number; failed?: number; claimed?: number; error?: string }> {
  await requireUser();
  const gate = await checkPermission("queue.process");
  if (isDenied(gate)) return gate;
  // ... existing body unchanged
}
```

Apply to all eight: `runSecurityScanAction` (`security.run`), `runSeoScanAction` (`seo.run`), `saveGeoGridConfigAction` and `runGeoGridAction` (`geogrid.manage`), `generateReportAction` (`reports.generate`), `revokeReportAction` (`reports.manage`), `processQueueNowAction` and `drainQueueAction` (`queue.process`). All except the queue pair also take `checkSiteAccess(siteId)`.

- [ ] **Step 4: Run the tests**

Run: `npm test` — expected PASS, including the 237 pre-existing.

- [ ] **Step 5: Verify and commit**

```bash
npx tsc --noEmit && npm run build
git add "src/app/(dashboard)" tests/authz-actions-analytics.test.ts
git commit -m "feat(authz): gate scan, geogrid, report and queue actions"
```

---

### Task 7: Enforce — pages, scoped dashboard, route handlers

**Files:**
- Modify: all 12 files under `src/app/(dashboard)/**/page.tsx`
- Modify: `src/app/(dashboard)/layout.tsx`
- Modify: `src/app/api/batches/[id]/route.ts`
- Modify: `src/middleware.ts` (comment only)
- Modify: `src/services/sites/service.ts` — scoped listing
- Test: `tests/authz-pages.test.ts`

- [ ] **Step 1: Scope the site list**

`listSites` currently returns every row. Add a viewer-scoped variant in `src/services/sites/service.ts` rather than filtering in each page:

```ts
/** Sites this viewer may see: all of them, or exactly their grants. */
export async function listSitesForViewer(
  deps: SitesDeps, viewer: Viewer,
): Promise<SiteRow[]> {
  const all = await deps.repo.listSites();
  const visible = visibleSiteIds(viewer, all.map((s) => s.id));
  return visible === "all" ? all : all.filter((s) => visible.includes(s.id));
}
```

- [ ] **Step 2: Guard every page**

Each page calls the relevant helper before fetching. None relies on the layout having checked — a page is directly requestable.

| Page | First line of the component body |
|---|---|
| `/dashboard` | `const viewer = await requireViewer();` then `listSitesForViewer` |
| `/sites/new` | `await requirePermission("sites.manage");` |
| `/sites/[id]` + 6 tabs | `await requireSiteAccess(id);` |
| `/marketplace`, `/marketplace/themes` | `await requirePermission("wp_toolkit.manage");` |
| `/marketplace/batches/[id]` | `await requirePermission("wp_toolkit.manage");` |

- [ ] **Step 3: Guard the batch route**

`/api/batches/[id]` currently returns any batch to any authenticated user, including the site names in it. Require a viewer, then filter the returned rows to sites the viewer may see; if none remain, 404.

- [ ] **Step 4: Record why middleware holds no checks**

Add to `src/middleware.ts`:

```ts
// This middleware refreshes the Supabase session and redirects anonymous
// visitors. It performs NO authorization, and must never be given any.
// Next.js CVE-2025-29927 let a crafted x-middleware-subrequest header convince
// the framework middleware had already run, skipping it entirely — every app
// whose only gate lived here was fully exposed. Middleware is an optimisation
// the framework can short-circuit, not a security boundary. Authorization
// belongs in each page, server action and route handler. See
// docs/superpowers/specs/2026-08-29-phase9a-authorization-design.md §4.2.
```

- [ ] **Step 5: Test, verify, commit**

Assert the scoped listing (a client sees only granted sites; an admin sees all) and that the batch route filters. Then:

```bash
npm test && npx tsc --noEmit && npm run build
node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json "src/app/(dashboard)"
git commit -m "feat(authz): gate pages, scope the dashboard, guard the batch route"
```

---

### Task 8: RLS rewrite

Nothing changes behaviourally when this lands — all code still runs on service-role, which bypasses RLS. It exists so Task 9's client read path has something to enforce, and as the backstop for a future missed check.

**Files:**
- Create: `supabase/migrations/0008_rls_scoped.sql`
- Test: `tests/authz-rls.test.ts`

- [ ] **Step 1: Write the failing test**

Assert structurally: `team_all` is dropped from all 12 tables; every one of the 16 tables has at least one policy; every policy names `to authenticated`; helper calls are wrapped as `(select …)`; and `user_site_access`'s self-read does **not** call `has_site_access` (the recursion trap).

- [ ] **Step 2: Write the migration**

Drop `team_all` on each of the 12 existing tables and add scoped policies per spec §6. Child tables scope by `has_site_access(site_id)`; `jobs` and `activity_log` are staff-only (`authorize('sites.view_all')`); `vuln_feed` is readable by any authenticated user. The four new tables get their own policies, with `user_site_access`'s self-read written as `user_id = (select auth.uid())`.

- [ ] **Step 3: Apply and verify nothing broke**

Apply in the Supabase SQL editor, then load the app as the admin and confirm every page still works. It should be indistinguishable — the admin path uses service-role.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(authz): replace blanket RLS with scoped policies"
```

---

### Task 9: The client read path and hidden fields

This is the task that makes the RLS policies load-bearing. Without it they are decoration.

**Files:**
- Create: `src/lib/authz/db.ts`
- Modify: the 12 dashboard pages' data reads
- Modify: `src/app/(dashboard)/sites/[id]/page.tsx` — hide credentials-adjacent fields
- Modify: the site tab components — hide action controls for read-only viewers
- Test: `tests/authz-db.test.ts`

- [ ] **Step 1: The read client**

Create `src/lib/authz/db.ts`:

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import type { Viewer } from "./decide";

/**
 * Which Supabase client a PAGE should read through.
 *
 * Clients get the user-scoped client, so the RLS policies from migration 0008
 * are the actual boundary: a client cannot read another client's site data
 * even if this application's code is wrong, because Postgres refuses. Staff
 * keep service-role, where authorization is the explicit check in each page.
 *
 * Writes are not routed here. Every write on every path is explicitly checked.
 */
export async function readDbFor(viewer: Viewer): Promise<SupabaseClient> {
  return viewer.role === "client" ? await createServerSupabase() : createServiceSupabase();
}
```

- [ ] **Step 2: Swap page reads**

In each of the 12 pages, replace `createServiceSupabase()` with `await readDbFor(viewer)`. Server **actions** keep `createServiceSupabase()` — they are writes and are explicitly gated.

- [ ] **Step 3: Hide credentials-adjacent fields**

On `/sites/[id]`, the Connection card renders `site.mcp_endpoint` and `site.wp_username`. Both are hidden for a viewer whose role is `client` — the rows are omitted, not blanked. Also hide the "Copy WP username" control and the "Open wp-admin" button, which exist to serve operators.

- [ ] **Step 4: Hide action controls for read-only viewers**

Every `ManageForm`, bulk bar, install panel and configuration form on the site tabs is rendered only when the viewer holds the matching permission. **Absent, not disabled** — a greyed control invites a support ticket.

This is presentation only. Each of those actions is independently gated server-side; the UI just stops offering what the server would refuse.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npx tsc --noEmit && npm run build
node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json "src/app/(dashboard)"
git commit -m "feat(authz): route client reads through RLS and hide operator-only surfaces"
```

---

### Task 10: Live RLS verification and documentation

A policy that was never executed was never tested. TypeScript tests cannot prove Postgres refuses.

**Files:**
- Create: `scripts/verify-rls.ts`
- Create: `docs/ops/authorization.md`
- Modify: `README.md`

- [ ] **Step 1: Write the verification script**

`scripts/verify-rls.ts` proves the boundary against the real database:

1. Create a temporary client user via the admin API; give them role `client` and a grant on exactly one of the two sites.
2. Sign in as them to obtain a user-scoped client.
3. Assert: `select` on `sites` returns exactly the granted site.
4. Assert: `select` on `sites` filtered to the *ungranted* site id returns zero rows.
5. Assert: `select` on `site_snapshots` for the ungranted site returns zero rows.
6. Assert: an `update` on the granted site is rejected.
7. Delete the temporary user and its rows, whatever the outcome — use `try/finally`.

Print a pass/fail line per assertion and exit non-zero on any failure.

- [ ] **Step 2: Run it**

```bash
npx tsx scripts/verify-rls.ts
```
All assertions must pass. **If step 4 or 5 passes rows through, stop — that is the exact cross-tenant leak this phase exists to prevent.**

- [ ] **Step 3: Write the ops doc**

`docs/ops/authorization.md`: the four roles and the default matrix; how to change a role or grant a site by SQL until Phase 9b ships; that role and permissions are read per request so revocation is immediate; that middleware holds no checks and why; the deploy ordering rule (migrations and bootstrap before enforcement); and how to re-run `verify-rls.ts`.

- [ ] **Step 4: Update the README** feature list, briefly.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-rls.ts docs/ops/authorization.md README.md
git commit -m "docs: authorization operations and live RLS verification"
```

---

## Definition of done

- `npx tsc --noEmit` clean, `npm run build` clean, `npm test` green with no fewer than 237 tests.
- Detector returns `[]` for every changed UI file; no horizontal overflow at 375px.
- Migrations 0006, 0007 and 0008 applied; `bootstrap-admin` run; exactly one `user_roles` row, role `admin`.
- `verify-rls.ts` passes every assertion against the real database.
- Every row of spec §4.3 has a test asserting refusal without the permission.
- A client account can see only its granted site, cannot see `mcp_endpoint` or `wp_username`, and is offered no action control other than generating a report.
