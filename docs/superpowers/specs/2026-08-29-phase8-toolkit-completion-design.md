# Phase 8 — WP Toolkit Completion (Design)

**Date:** 2026-08-29
**Status:** Approved for planning
**Depends on:** Phases 1–7 (merged). Extends the design in
`2026-08-27-wp-control-panel-design.md`; does not supersede it.

## Goal

Finish the WordPress management surface: full theme lifecycle (install, activate,
update, delete), plugin delete, multi-select bulk actions on both tables, and a
direct route into each site's `wp-admin`.

## Non-goals

- **Users and RBAC.** A separate subsystem with its own spec (Phase 9). Nothing
  in this phase adds a permission check; every action remains available to any
  authenticated user, exactly as today.
- **One-click wp-admin auto-login (token SSO).** Deliberately deferred — see
  §6.2 for why and what a later phase would need to build.
- **Cross-site theme rollout from the site Themes tab.** Cross-site install lives
  in the Marketplace; the per-site installer targets one site.

---

## 1. Verified constraints

Everything below was executed against `staging.acad1.ph` (WordPress 7.1,
PHP 8.3.33, `WP_Filesystem` method `direct`) before this spec was written.
These are measurements, not assumptions.

| Capability | Result |
|---|---|
| `delete_theme()` | available, after `require_once ABSPATH.'wp-admin/includes/theme.php'` |
| `delete_plugins()` | available, after `.../includes/plugin.php` |
| `themes_api()` | available, after `.../includes/theme-install.php` |
| `plugins_api()` | available, after `.../includes/plugin-install.php` |
| `Theme_Upgrader` | available |
| wp.org theme API reachable from host | yes — `themes_api('theme_information', ['slug'=>'twentytwentyfour'])` returned `Twenty Twenty-Four 1.6` |
| theme root writable | yes |
| `admin_url()` | `https://staging.acad1.ph/wp-admin/` |

**Include guards must test a function that actually lives in the target file.**
The first probe used `if (!function_exists('get_themes'))` to guard requiring
`theme.php`. `get_themes()` is a deprecated shim that is always loaded, so the
require was skipped and `delete_theme` appeared unavailable. Guard on
`delete_theme` / `themes_api` / `plugins_api` themselves, or require
unconditionally (the files are `require_once`).

### 1.1 Application Passwords cannot log in to wp-admin

Measured on WordPress 7.1 by minting a real application password and running the
browser login path with `application_password_is_api_request` forced false:

| Path | Result |
|---|---|
| `wp_authenticate_application_password` | returned `null` — declined |
| `wp_authenticate_username_password` | `WP_Error: incorrect_password` |
| `wp_authenticate()` (full stack) | `WP_Error: incorrect_password` |
| `wp_check_password($appPassword, $user->user_pass)` | `no` |

Core's own guard is the reason:

```php
$is_api_request = ( ( defined( 'XMLRPC_REQUEST' ) && XMLRPC_REQUEST )
                 || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) );
$is_api_request = apply_filters( 'application_password_is_api_request', $is_api_request );
```

A browser POST to `wp-login.php` defines neither constant, so the
application-password authenticator never runs, and the stored credential is not
the user's `user_pass` hash. **Posting the stored username + application password
to `wp-login.php` cannot work.** Any design that assumes otherwise is wrong.

> Note for future probes: a `novamira/execute-php` call *is* a REST request, so
> `REST_REQUEST` is defined inside it. Testing login behaviour without forcing
> `application_password_is_api_request` to false produces a false positive.

---

## 2. Theme management

### 2.1 Operations

One service, `src/services/themes/`, all executed through `runPhp`
(`src/lib/wpphp.ts`) as with every other WordPress operation.

| Operation | Mechanism |
|---|---|
| Install from wp.org | `themes_api('theme_information', {slug})` → `Theme_Upgrader::install($download_link)` |
| Install from upload | signed storage URL → `Theme_Upgrader::install($url, ['overwrite_package' => true])` |
| Activate | `switch_theme($stylesheet)` |
| Update | `Theme_Upgrader::upgrade($stylesheet)` |
| Delete | `delete_theme($stylesheet)` |

Install reuses the shape of `src/services/marketplace/install.ts`, including its
`folder_exists` short-circuit: a theme directory that already exists makes
`install()` fail deterministically, so an already-installed slug returns success
(activating if requested) rather than burning three retry attempts.

Uploads reuse the Phase 4 signed-URL path: the browser uploads to a private
bucket, the server hands WordPress a short-lived signed URL, and the query string
is stripped before any error reaches `jobs.last_error` so the token cannot leak.
A new `themes` bucket mirrors the existing `plugins` bucket.

### 2.2 Delete safety gate

The one piece of logic in this phase that can take a client site down. It is a
**pure function**, `canDeleteTheme(themes, slug, activeStylesheet, activeTemplate)`,
unit-tested directly, and it is enforced **server-side before the PHP is built** —
not only by hiding a button.

Four refusal reasons, each with its own message:

1. **Active** — `slug === activeStylesheet`.
2. **Parent of the active theme** — `slug === activeTemplate && activeTemplate !== activeStylesheet`.
   This is the case that motivated the gate: on `staging.acad1.ph` the active
   theme is `acad1-child`, whose parent `generatepress` reports `status:
   inactive`. A naive "delete any inactive theme" rule offers a Delete button
   that breaks the live site.
3. **Parent of any installed child** — some other installed theme declares this
   slug as its template, active or not. Deleting it orphans that child.
4. **Last theme installed** — WordPress needs a fallback theme to exist.

`ThemeInfo` (`src/services/inventory/types.ts`) currently carries no parent
field, so the gate cannot be evaluated from a snapshot. **`ThemeInfo` gains
`template: string`** (the stylesheet's parent slug; equal to its own slug for a
non-child theme), populated by the inventory collector. This is an additive
field on a JSONB payload; snapshots taken before this change simply lack it, and
the gate treats a missing `template` as "unknown parentage" and refuses deletion
until the inventory is refreshed. Failing closed here is correct — the cost is
one extra click, the alternative is a broken site.

### 2.3 Activation guard

`switch_theme()` on a child theme whose parent is missing produces a broken site.
Activation validates that the target's `template` resolves to an installed theme.

---

## 3. Plugin delete

`delete_plugins([$file])`, refused server-side when the plugin is active
(WordPress refuses too, but a clear message beats a raw error).

**The confirmation copy must state the actual consequence.** `delete_plugins()`
invokes each plugin's uninstall hook, which routinely drops its database tables
and options. That is irreversible and materially different from "deactivate".
The dialog says so in plain words rather than asking "are you sure?".

`ManageAction` gains two variants:

```ts
| { kind: "delete_plugin"; file: string }
| { kind: "delete_theme"; slug: string }
```

---

## 4. Bulk actions

### 4.1 Execution model

**Bulk operations are enqueued as a job batch**, reusing the Phase 4 batch
infrastructure (`jobs.batch_id`, `/api/batches/[id]`, the batch poller UI).

The reasoning, stated because it is the main architectural choice here: a single
plugin update is one MCP round trip taking seconds; twenty of them can exceed the
300-second function ceiling, and an inline server action that times out halfway
leaves no record of which items succeeded. The queue gives per-item status,
survives timeouts, retries on the existing 60s/300s/fail-at-3 ladder, and is
already built and reviewed. The cost is that local development requires pressing
"Process queue now", exactly as GeoGrid does today.

New job type: `bulk_manage`. One job is enqueued **per target**, all sharing a
`batch_id`, so each item retries and reports independently and one failure never
aborts its siblings. Payload is a single target, not a list:

```ts
{ action: ManageAction["kind"], target: string, label: string }
```

`target` is the plugin basename or theme stylesheet; `label` is the display name
captured at enqueue time so the batch view can name the item even if the
inventory changes underneath it.

`JobType` gains `"bulk_manage"`.

### 4.2 Eligibility

The bulk bar offers only the actions valid for the current selection, and the
server re-checks every item independently:

| Action | Applies to |
|---|---|
| Update | items with `update === "available"` |
| Activate | inactive plugins |
| Deactivate | active plugins |
| Delete (plugin) | inactive plugins |
| Delete (theme) | themes passing the §2.2 gate |

Ineligible items are excluded from the batch with a per-item reason, surfaced in
the results view rather than silently dropped. **A bulk action never partially
applies without saying which items it skipped and why.**

### 4.3 Interaction

- Header checkbox with a real `indeterminate` state; per-row checkboxes.
- Selection is client state in a small `useSelection` hook; it does not survive
  navigation, which is correct — a stale selection acting on a refreshed
  inventory is a bug waiting to happen.
- A bulk bar appears when the selection is non-empty, showing the count and the
  eligible actions.
- Confirm modal lists the affected items by name, and for destructive actions
  names the consequence (§3).
- On submit, redirect to the batch page, which already polls and reports per-item
  status.

**The batch view needs one change to be reusable.** `/api/batches/[id]` currently
labels every row by *site name*, because batches were built for installing one
plugin across many sites. A bulk batch is the transpose — one site, many items —
so every row would read the same site name. The route returns a `label` field
(`payload.label` when present, falling back to the site name) and the poller
renders that column as "Item". This keeps one batch view serving both shapes
instead of forking a near-identical second one.

---

## 5. wp-admin access

A button on the site header opening `admin_url` in a new tab with
`rel="noopener noreferrer"`, plus the site's WordPress username displayed with a
copy control so a password manager has what it needs.

**`InventoryPayload` gains `admin_url: string`**, collected via WordPress's own
`admin_url()`. Concatenating `/wp-admin` onto the stored site URL is wrong for
subdirectory installs and for sites whose `site_url` differs from `home_url`;
asking WordPress is exact. When the field is absent (pre-upgrade snapshot), fall
back to `${site.url}/wp-admin/` and let a refresh correct it.

No credentials are transmitted, and each site's own login — including its 2FA —
remains in force.

---

## 6. Security

### 6.1 Within this phase

- Slug and plugin-file inputs are validated against `SLUG_RE` / a plugin-basename
  pattern before being embedded, and all values reach PHP through `phpString()`
  base64 encoding (`src/lib/wpphp.ts`), never string interpolation.
- Signed upload URLs have their query string stripped before any error text is
  persisted to `jobs.last_error`.
- Destructive operations are gated server-side. UI state is a convenience, never
  the boundary.

### 6.2 Deferred: token-based wp-admin SSO

Recorded here so a later phase starts from evidence rather than re-deriving it.

Since application passwords cannot produce a session (§1.1), one-click wp-admin
requires an endpoint *inside* WordPress that mints a session — the pattern every
commercial panel uses (MainWP, WP Umbrella, Jetpack SSO all end at
`wp_set_auth_cookie()`).

**This is functionally an authentication bypass.** MainWP Child ≤5.2.1 shipped
exactly this feature and earned CVE-2024-10783 (CVSS 9.2): its login path
resolved a user *by username* and called `wp_set_auth_cookie()` without verifying
a secret, reachable unauthenticated whenever a companion safety flag sat at its
default-off value. The architectural risk is larger than the bug: a token
endpoint makes a compromise of this panel a silent admin takeover of every
managed site at once, bypassing each site's 2FA.

If built later, it is opt-in per site and must have: a 256-bit `random_bytes`
token (never `wp_create_nonce`), hash-only storage, ≤120s TTL, atomic
single-use consumption, binding to one user ID re-validated as an administrator
at redeem time, HTTPS-only, `Referrer-Policy: no-referrer` on the referring page,
the token stripped from the URL after use, `wp_safe_redirect` with no
caller-supplied `redirect_to`, rate limiting on both issue and redeem, and an
audit record for every issuance and every redemption including failures.

**Forcing `application_password_is_api_request` to true is not an acceptable
shortcut.** It converts the stored application password into a permanent,
replayable wp-admin credential with no expiry and no single-use protection —
strictly worse than a scoped token.

---

## 7. File structure

**New**

- `src/services/themes/types.ts` — theme operation types, `ThemeDeleteRefusal`
- `src/services/themes/safety.ts` — `canDeleteTheme`, `canActivateTheme` (pure)
- `src/services/themes/install.ts` — wp.org + upload install PHP builders
- `src/services/themes/service.ts` — activate / update / delete orchestration
- `src/services/bulk/types.ts` — bulk request, per-item eligibility result
- `src/services/bulk/service.ts` — eligibility filter + batch enqueue
- `src/components/ui/selection.tsx` — `useSelection`, `SelectAllCheckbox`, `RowCheckbox`, `BulkBar`
- `src/app/(dashboard)/sites/[id]/themes/install-panel.tsx` — per-site installer
- `src/app/(dashboard)/marketplace/themes/page.tsx` — Marketplace Themes surface
- `supabase/migrations/0005_storage_themes.sql` — private `themes` bucket
- `tests/theme-safety.test.ts`, `tests/theme-install.test.ts`, `tests/bulk-eligibility.test.ts`

**Modified**

- `src/services/inventory/types.ts` — `ThemeInfo.template`, `InventoryPayload.admin_url`
- `src/services/inventory/service.ts` — collect both fields
- `src/services/manage/types.ts` — `delete_plugin`, `delete_theme` variants
- `src/services/manage/service.ts` — handlers for both, with server-side gates
- `src/services/jobs/types.ts` — `bulk_manage` job type
- `src/services/jobs/handlers.ts` — `bulk_manage` handler
- `src/lib/adapters/wporg.ts` — theme search/info alongside plugins
- `src/app/(dashboard)/sites/[id]/plugins/page.tsx` — selection + delete
- `src/app/(dashboard)/sites/[id]/themes/page.tsx` — selection + full CRUD
- `src/app/(dashboard)/sites/[id]/page.tsx` — wp-admin button
- `src/app/(dashboard)/marketplace/page.tsx` — Plugins/Themes navigation
- `src/app/api/batches/[id]/route.ts` — per-job `label` field (§4.3)
- `src/app/(dashboard)/marketplace/batches/[id]/poller.tsx` — render `label` as "Item"

**Both install surfaces call `src/services/themes/install.ts`.** The two UIs are
independent, as requested; the behaviour they invoke is defined once so they
cannot drift into installing themes differently.

---

## 8. Testing

Vitest, dependency injection, `MockMcpClient` — the existing pattern. 163 tests
pass today and must still pass.

- **`canDeleteTheme` is the priority.** Table-driven cases covering each refusal
  reason, including the exact `acad1-child` / `generatepress` shape found live,
  a child whose parent is inactive, the single-theme case, and a snapshot with
  `template` missing (must refuse).
- **PHP builders** are asserted as strings: correct requires present, slug passed
  through `phpString`, `overwrite_package` only on uploads, no raw interpolation.
- **Bulk eligibility** — a mixed selection yields the right included/excluded
  split with reasons; an all-ineligible selection enqueues nothing.
- **Job handler** — one job per target; a failing item does not abort its
  siblings.
- **Live verification before merge**, per established practice: install, update
  and delete a real theme on `staging.acad1.ph`, and confirm the gate refuses
  `generatepress` while `acad1-child` is active.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Deleting a parent theme breaks a live site | §2.2 gate, server-enforced, unit-tested, fails closed on unknown parentage |
| Plugin delete destroys plugin data via uninstall hooks | Consequence named in the confirmation copy; refused while active |
| Bulk operation exceeds the function time limit | Queue-backed batches with per-item retry (§4.1) |
| Stale selection acts on refreshed inventory | Selection is ephemeral client state, cleared on navigation |
| Signed upload URL leaking into an error row | Query string stripped before persisting (existing Phase 4 behaviour) |
| Older snapshots lack `template` / `admin_url` | Both handled with explicit fallbacks; theme delete fails closed, wp-admin degrades to a constructed URL |
