# Automated Hardening — Design

**Date:** 2026-09-12
**Status:** Implemented 2026-09-12

## Goal

The security scanner already detects seven hardening problems across the fleet
(xmlrpc 13 sites, inactive plugins 12, wp-config permissions 11, file editing 9,
admin username 8, security headers 7, uploads listing 5) and offers no way to fix
any of them. Each warn costs 2 points; a site with zero vulnerabilities and six
warns is a B. This adds the fix.

## Fixes, and exactly what each changes

Every fix is a single, independently reversible file operation. None edits
`wp-config.php` or `.htaccess`.

| Check | Fix id | What is written | Why this form |
|---|---|---|---|
| `xmlrpc_enabled` | `xmlrpc` | `wp-content/mu-plugins/ocs-disable-xmlrpc.php` — returns 403 when `XMLRPC_REQUEST` is defined, and filters `xmlrpc_enabled` false | The scanner does a GET; WordPress's own filter only affects POST handling and still answers 405, which the scanner treats as enabled. A 403 at plugin load is server-agnostic (works under nginx, where `.htaccess` is ignored). |
| `file_edit_disabled` | `file_edit` | `wp-content/mu-plugins/ocs-disable-file-edit.php` — `define('DISALLOW_FILE_EDIT', true)` | `map_meta_cap` reads the constant at runtime, after mu-plugins load, so this works without touching `wp-config.php`. |
| `security_headers` | `headers` | `wp-content/mu-plugins/ocs-security-headers.php` — `send_headers`: `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` | Conservative set that breaks nothing. A page served from a static cache (WP Rocket) bypasses PHP and will not carry them; the post-apply verification reports that honestly. |
| `uploads_listing` | `uploads_index` | `wp-content/uploads/index.php` containing `<?php // Silence is golden.` | WordPress's own convention for every directory it ships; server-agnostic. |
| `wp_config_permissions` | `wp_config_perms` | `chmod 0640` on `wp-config.php` | `chmod` succeeds only when PHP owns the file, and the process that owns it can read it at 0640 — so success cannot break the site, and failure changes nothing. |

**Not automated:** `admin_username` (renaming an administrator is not something
to do unattended) and `inactive_plugins` (deleting plugins is a choice per
plugin; the Plugins tab's bulk delete with selection is the right tool, and the
Harden dialog says so).

## Actions

A dedicated service, `src/services/security/harden.ts`, rather than two new
`ManageAction` kinds as first drafted. `manageSite` returns one `{ok, message}`
and cannot carry per-fix outcomes or the before/after check results this
feature needs; a service of its own can, and stays out of the manage switch's
exhaustive tests.

```ts
hardenSite(deps, siteId, actorId, fixes: HardeningFix[], mode: "harden" | "unharden")
```

`HardeningFix = "xmlrpc" | "file_edit" | "headers" | "uploads_index" | "wp_config_perms"`.

`harden` writes each requested fix; `unharden` removes the mu-plugin or
`index.php` it wrote (permissions are not reverted — there is no "unfix" for
0640). Each is idempotent: applying a fix that is already applied is a no-op
that reports "already in place".

The PHP result reports per fix: `applied | already | failed(reason)`. Nothing
throws for one fix failing; the others still run.

### Verification

After `harden`, the action re-runs `runPhpHardening` and `runHttpHardening`
and returns the before/after result for each targeted check. "Applied" and
"the check now passes" are reported separately, because they can differ — a
static cache can serve stale headers, and a CDN can answer for `xmlrpc.php`.
The operator sees which.

### Plan

`hardeningPlan(checks: SecurityCheck[]): HardeningFix[]` — pure. Maps every
current `warn`/`fail` on a fixable check to its fix. This is what the Harden
button proposes, and what the fleet action applies.

## UI

- **Site security page:** a Harden button beside the grade when `hardeningPlan`
  is non-empty. Its confirm dialog lists each fix in plain words, notes that
  XML-RPC blocking breaks Jetpack and the WordPress mobile app, and mentions the
  two checks it will not touch. After running, a toast per check: fixed /
  applied but still failing (with the reason) / failed.
- **Dashboard:** a "Harden N sites" button beside the plugin-update button,
  scoped to the visible environment, same confirm shape, one `harden` job per
  site under a batch id. Uses `hardeningPlan` per site from the latest checks.

## Authorization

Same pair as every other write to a live site: `wp_toolkit.manage` plus a
per-site `manage` grant. Activity log: `site.manage.harden` with the fix list.

## Testing

1. `hardeningPlan` maps each fixable failing check to its fix, ignores passes,
   and never proposes `admin_username` or `inactive_plugins`.
2. Generated PHP for `harden`/`unharden` contains no backslashes.
3. Each mu-plugin body is a valid PHP prologue and contains the exact hook or
   constant the corresponding check reads.
4. `harden` with an unknown fix id is rejected at validation, before PHP.
5. The dashboard fleet action targets only the visible environment and only
   sites whose latest checks have something to fix (mutation-checked).
