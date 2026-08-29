# Theme management and bulk actions

## Why a theme delete can be refused

`canDeleteTheme` (`src/services/themes/safety.ts`) refuses for one of four
reasons. Each exists because deleting the wrong theme takes the site down
immediately, not eventually.

1. **The theme is active.** Deleting the theme WordPress is currently
   rendering the site with is an obvious break — activate a different theme
   first.
2. **The theme is the parent of the active theme.** This is the case that
   motivated the gate, because "inactive" is not a safe test for
   deletability. On `staging.acad1.ph`, the active theme is `acad1-child` and
   its parent is `generatepress`; WordPress reports `generatepress`'s own
   `status` as `"inactive"` even though the site depends on it at that exact
   moment — a child theme only supplies the files it overrides and falls
   through to the parent for everything else. A rule that offers a Delete
   button on any "inactive" theme would offer one on `generatepress` and
   break the live site. Verified live: `delete_theme` for `generatepress`
   returned `{"ok":false,"error":"Theme is the parent of the active theme"}`
   and deleted nothing; both themes were still installed afterwards.
3. **The theme is the parent of some other installed theme**, active or not.
   Deleting it orphans that child the moment it is ever activated.
4. **It is the only theme installed.** WordPress needs at least one theme to
   fall back to.

### Enforced twice

The gate is evaluated in two places, deliberately:

- **TypeScript**, against the inventory snapshot (`ThemeInfo[]` with each
  theme's `template` field — a child's parent slug, or its own slug for a
  non-child theme). This drives the UI: it decides whether a Delete button
  renders and which rows are excluded from a bulk selection, before any
  network call happens.
- **PHP**, generated per request and run against live WordPress state
  (`src/services/manage/service.ts`, `delete_theme` case). This copy is the
  one that actually protects the site — the TypeScript copy reads a snapshot
  that can be stale between an inventory refresh and the delete request, but
  the PHP copy re-reads `wp_get_themes()`, `get_stylesheet()`, and
  `get_template()` at the moment of the call.

Both copies apply the same four reasons independently; neither trusts the
other.

### Fails closed on old snapshots

`ThemeInfo.template` did not exist before this phase. A snapshot taken with
the old inventory collector has no `template` field on any theme, so the
gate cannot determine parentage from it. `canDeleteTheme` treats a missing or
non-string `template` on *any* theme in the list as "unknown parentage" and
refuses every delete with "Refresh the inventory first — this snapshot
predates parent-theme tracking." The cost is one extra "Refresh inventory"
click; the alternative is evaluating the parent-of-active-theme case against
data that doesn't have it, which could return a false ALLOWED. Refreshing
the inventory re-collects `template` for every theme and clears the refusal.

## Plugin delete destroys data

`delete_plugins()` (used by the `delete_plugin` manage action) invokes each
plugin's uninstall hook, which routinely drops that plugin's database tables
and options. This is **irreversible** and materially different from
deactivating a plugin, which leaves its data in place. The confirm dialog
states this consequence in plain words rather than a generic "are you sure?".

The server also refuses to delete a plugin that is active (checked with
`is_plugin_active()` / `is_plugin_active_for_network()`) — verified live: the
generated PHP for an active plugin returned "Deactivate the plugin before
deleting it" and deleted nothing. Deactivate first, confirm the site still
behaves as expected, then delete.

## Bulk actions run through the job queue

Selecting multiple rows and choosing an action (Update, Activate, Deactivate,
Delete) does not run inline. It enqueues one `bulk_manage` job **per selected
item**, all sharing a single `batch_id`. That means:

- A failure in one item retries independently on the normal job backoff
  (60s/300s/fail-at-3) without blocking or aborting its siblings.
- The batch page (`/api/batches/[id]`) polls and shows per-item status,
  labelled by the item's own name (plugin name or theme name) rather than by
  site name — bulk actions are one site with many items, the inverse of the
  cross-site marketplace batches the same view also serves.
- Like every other job, bulk jobs need something to drain the queue: in
  production that's the Supabase pg_cron schedule (`docs/ops/scheduling.md`);
  locally there is no scheduler, so press **"Process queue now"** after
  submitting a bulk action or it will sit queued.

Before enqueueing, the server re-checks eligibility for every selected item
independently (e.g. Delete only offered for inactive plugins or themes that
pass the delete gate above). An item that fails eligibility is **excluded
from the batch with a stated reason**, shown in the results — never silently
dropped and never allowed to partially apply without saying what it skipped.

## Theme uploads need migration 0005

Uploading a theme ZIP through the per-site installer stores it in a private
Supabase Storage bucket named `themes`, the same signed-URL pattern used for
plugin uploads. That bucket is created by
`supabase/migrations/0005_storage_themes.sql`. If it hasn't been applied, a
theme upload fails with "Bucket not found" — apply the migration
(`npx supabase db push`, or paste it into the SQL editor) before uploading.
Installing from wordpress.org does not touch storage and works without it.

## wp-admin access is a plain link

The site header has a button that opens the site's `admin_url` (collected
from WordPress's own `admin_url()`, not constructed by concatenating
`/wp-admin` onto the stored site URL, which breaks for subdirectory installs)
in a new tab with `rel="noopener noreferrer"`. No credentials are sent by the
panel; the site's own login — including its 2FA — still applies. The site's
WordPress username is shown next to the button with a copy control so a
password manager has what it needs to fill in the password.

**Application passwords cannot be used to log in there.** Measured on
WordPress 7.1 by minting a real application password and forcing
`application_password_is_api_request` to `false` to reproduce the real
`wp-login.php` browser path (a REST-context probe gives a false positive,
because `REST_REQUEST` is already defined inside it): the
application-password authenticator declined and returned `null`,
`wp_authenticate_username_password` returned `WP_Error: incorrect_password`,
and `wp_check_password($appPassword, $user->user_pass)` returned `no` — the
stored application password is simply not the user's `user_pass` hash, so
posting it to `wp-login.php` cannot work by construction, not as a bug to
fix.

A future one-click auto-login would need a token-based SSO endpoint inside
WordPress instead (the pattern MainWP, WP Umbrella, and Jetpack SSO all use).
That is deliberately out of scope for this phase — see §6.2 of
`docs/superpowers/specs/2026-08-29-phase8-toolkit-completion-design.md` for
the security analysis (it is functionally an authentication bypass; MainWP
Child shipped a version of it and earned CVE-2024-10783) and the full list of
properties such an endpoint would have to implement before it would be safe
to build.

## `wp_get_themes()` caching — a trap for future code

`wp_get_themes()` caches its result within a single PHP request. Reading the
theme list immediately after calling `delete_theme()` in the *same* request
still returns the deleted theme, because the cache was populated before the
delete and nothing invalidates it automatically. This app is unaffected today
because the inventory refresh that re-reads themes always runs as a separate
job/request from the delete itself. But any future code that deletes (or
installs) a theme and then re-reads `wp_get_themes()` in the same request
must call `wp_clean_themes_cache()` first, or it will act on stale data.
