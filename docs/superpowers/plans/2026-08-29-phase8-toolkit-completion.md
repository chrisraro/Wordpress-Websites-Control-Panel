# Phase 8 — WP Toolkit Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the WordPress management surface — full theme lifecycle (install, activate, update, delete), plugin delete, multi-select bulk actions on both tables, and a direct route into each site's wp-admin.

**Architecture:** Every WordPress operation goes through `runPhp` (`src/lib/wpphp.ts`), matching the existing `manage` service. Destructive operations are gated twice: a pure TypeScript function drives UI eligibility and is unit-tested, and an authoritative PHP check runs inside WordPress where the truth is fresh. Bulk operations enqueue one job per target sharing a `batch_id`, reusing the Phase 4 batch infrastructure.

**Tech Stack:** Next.js 15.5.24 (App Router, Server Actions), React 19.2.8, TypeScript strict, Tailwind v4, Supabase (Postgres + Storage), `@modelcontextprotocol/sdk` 1.30.0, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-29-phase8-toolkit-completion-design.md`. Read it before starting.
- **No WP-CLI.** The fleet's hosting exposes a broken `cgi-fcgi` SAPI to the `wp` binary. All WordPress work goes through `novamira/execute-php` via `runPhp`.
- **Every dynamic value reaching PHP goes through `phpString()`** (base64), never string interpolation. Validate slugs with `SLUG_RE` and plugin files with `PLUGIN_FILE_RE` from `src/services/manage/service.ts` first.
- **Include guards must test a function that actually lives in the target file.** `get_themes()` is a deprecated always-loaded shim; guarding on it skips requiring `theme.php`. Guard on `delete_theme` / `themes_api` / `plugins_api`, or `require_once` unconditionally.
- **Unwrap the MCP envelope** via `unwrapAbility` (`src/lib/mcp/envelope.ts`). `runPhp` already does this.
- **Server actions used with `useActionState` must accept `(…boundArgs, prevState, formData)`.** Never paper over a mismatch with `as unknown as`.
- **UI follows `DESIGN.md`** and the token vocabulary in `src/components/ui/styles.ts`. Run `node C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs --json <changed files>` after UI work; responsive down to 375px is mandatory.
- **All 163 existing tests must still pass.** Run `npm test` before every commit.
- **Do not add permission checks.** RBAC is Phase 9; every action stays available to any authenticated user.

---

### Task 1: Inventory gains `template` and `admin_url`

The theme delete gate cannot be evaluated without knowing each theme's parent, and the wp-admin link must not be built by concatenating `/wp-admin` onto the stored URL.

**Files:**
- Modify: `src/services/inventory/types.ts`
- Modify: `src/services/inventory/service.ts` (the `INVENTORY_PHP` constant)
- Test: `tests/inventory-service.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ThemeInfo.template: string` (parent stylesheet slug; equals the theme's own slug when it is not a child), `InventoryPayload.admin_url: string`. Both are consumed by Tasks 2, 6 and 9.

- [ ] **Step 1: Write the failing test**

Add to `tests/inventory-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { INVENTORY_PHP } from "@/services/inventory/service";

describe("INVENTORY_PHP", () => {
  it("collects each theme's parent template", () => {
    expect(INVENTORY_PHP).toContain("'template' => $t->get_template()");
  });

  it("collects admin_url from WordPress rather than building it", () => {
    expect(INVENTORY_PHP).toContain("'admin_url' => admin_url()");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/inventory-service.test.ts`
Expected: FAIL — both assertions, `INVENTORY_PHP` does not contain those strings.

- [ ] **Step 3: Add the fields to the types**

In `src/services/inventory/types.ts`, add to `ThemeInfo`:

```ts
export interface ThemeInfo {
  /** Stylesheet slug, e.g. "generatepress" */
  name: string;
  /**
   * Parent stylesheet slug. Equals `name` for a theme that is not a child.
   * Required by the delete gate: a parent theme reports status "inactive"
   * while its child is active, so parentage is the only way to tell that
   * deleting it would break the site.
   */
  template: string;
  title?: string;
  version: string;
  status: string;
  update: string;
  update_version?: string | null;
}
```

And to `InventoryPayload`:

```ts
export interface InventoryPayload {
  collected_at: string;
  wp_version: string;
  php_version: string;
  /** WordPress's own admin_url() — correct for subdirectory installs. */
  admin_url: string;
  core_update: string | null;
  plugins: PluginInfo[];
  themes: ThemeInfo[];
  admin_users: AdminUser[];
}
```

- [ ] **Step 4: Collect the fields in PHP**

In `src/services/inventory/service.ts`, inside the theme loop of `INVENTORY_PHP`, add `template` immediately after `name`:

```php
  $themes[] = array(
    'name' => $stylesheet,
    'template' => $t->get_template(),
    'title' => $t->get('Name'),
```

And add `admin_url` to the returned array, after `php_version`:

```php
return json_encode(array(
  'wp_version' => get_bloginfo('version'),
  'php_version' => PHP_VERSION,
  'admin_url' => admin_url(),
  'core_update' => $core,
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, including all 163 pre-existing tests.

- [ ] **Step 6: Verify against a live site**

The collector is the one thing a unit test cannot prove. Run the real inventory against staging and confirm both fields arrive:

```bash
npx tsx -e "
import { createSiteMcpClient } from './src/lib/mcp/client';
" 2>/dev/null || echo "Use the app: refresh inventory on a site, then inspect the snapshot payload in Supabase for themes[].template and admin_url."
```

Preferred: start the dev server, open a site, press **Refresh inventory**, then confirm in Supabase that the newest `site_snapshots.payload` contains `admin_url` and a `template` on every theme. On a site with a child theme, the parent's slug must appear as the child's `template`.

- [ ] **Step 7: Commit**

```bash
git add src/services/inventory tests/inventory-service.test.ts
git commit -m "feat(inventory): collect theme parent template and admin_url"
```

---

### Task 2: Theme safety gate (pure functions)

The single piece of logic in this phase that can take a client site down.

**Files:**
- Create: `src/services/themes/types.ts`
- Create: `src/services/themes/safety.ts`
- Test: `tests/theme-safety.test.ts`

**Interfaces:**
- Consumes: `ThemeInfo` from Task 1.
- Produces:
  - `type ThemeRefusal = { allowed: false; reason: string }`
  - `type ThemeVerdict = { allowed: true } | ThemeRefusal`
  - `canDeleteTheme(themes: ThemeInfo[], slug: string): ThemeVerdict`
  - `canActivateTheme(themes: ThemeInfo[], slug: string): ThemeVerdict`
  - `deletableThemes(themes: ThemeInfo[]): string[]`
  Consumed by Tasks 3, 5, 7 and 8.

- [ ] **Step 1: Write the failing test**

Create `tests/theme-safety.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canActivateTheme, canDeleteTheme, deletableThemes } from "@/services/themes/safety";
import type { ThemeInfo } from "@/services/inventory/types";

const theme = (over: Partial<ThemeInfo> & { name: string }): ThemeInfo => ({
  template: over.name,
  version: "1.0",
  status: "inactive",
  update: "none",
  ...over,
});

// The exact shape found on staging.acad1.ph: the active theme is a child, and
// its parent reports status "inactive".
const CHILD_SETUP: ThemeInfo[] = [
  theme({ name: "acad1-child", template: "generatepress", status: "active" }),
  theme({ name: "generatepress" }),
  theme({ name: "twentytwentyfour" }),
];

describe("canDeleteTheme", () => {
  it("refuses the active theme", () => {
    const v = canDeleteTheme(CHILD_SETUP, "acad1-child");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/active/i);
  });

  it("refuses the parent of the active theme", () => {
    const v = canDeleteTheme(CHILD_SETUP, "generatepress");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/parent/i);
  });

  it("refuses the parent of an inactive child", () => {
    const themes = [
      theme({ name: "twentytwentyfour", status: "active" }),
      theme({ name: "storefront" }),
      theme({ name: "storefront-child", template: "storefront" }),
    ];
    const v = canDeleteTheme(themes, "storefront");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/parent/i);
  });

  it("allows an unrelated inactive theme", () => {
    expect(canDeleteTheme(CHILD_SETUP, "twentytwentyfour")).toEqual({ allowed: true });
  });

  it("refuses the last remaining theme", () => {
    const only = [theme({ name: "twentytwentyfour", status: "active" })];
    const v = canDeleteTheme(only, "twentytwentyfour");
    expect(v.allowed).toBe(false);
  });

  it("refuses a theme that is not installed", () => {
    expect(canDeleteTheme(CHILD_SETUP, "nope").allowed).toBe(false);
  });

  it("fails closed when parentage is unknown (pre-upgrade snapshot)", () => {
    // Snapshots taken before Task 1 have no `template`. Allowing a delete here
    // could remove a parent theme and break the site, so refuse until refresh.
    const legacy = [
      { name: "a", version: "1", status: "active", update: "none" },
      { name: "b", version: "1", status: "inactive", update: "none" },
    ] as unknown as ThemeInfo[];
    const v = canDeleteTheme(legacy, "b");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/refresh/i);
  });
});

describe("canActivateTheme", () => {
  it("refuses a child whose parent is missing", () => {
    const orphan = [
      theme({ name: "twentytwentyfour", status: "active" }),
      theme({ name: "lonely-child", template: "absent-parent" }),
    ];
    const v = canActivateTheme(orphan, "lonely-child");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/parent/i);
  });

  it("allows a theme whose parent is installed", () => {
    expect(canActivateTheme(CHILD_SETUP, "acad1-child")).toEqual({ allowed: true });
  });

  it("refuses the already-active theme", () => {
    expect(canActivateTheme(CHILD_SETUP, "acad1-child").allowed).toBe(true);
    expect(canActivateTheme(CHILD_SETUP, "missing").allowed).toBe(false);
  });
});

describe("deletableThemes", () => {
  it("returns only the safely removable slugs", () => {
    expect(deletableThemes(CHILD_SETUP)).toEqual(["twentytwentyfour"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/theme-safety.test.ts`
Expected: FAIL — `Cannot find module '@/services/themes/safety'`.

- [ ] **Step 3: Write the types**

Create `src/services/themes/types.ts`:

```ts
export type ThemeRefusal = { allowed: false; reason: string };
export type ThemeVerdict = { allowed: true } | ThemeRefusal;

export const ALLOWED: ThemeVerdict = { allowed: true };
export const refuse = (reason: string): ThemeRefusal => ({ allowed: false, reason });
```

- [ ] **Step 4: Write the implementation**

Create `src/services/themes/safety.ts`:

```ts
import type { ThemeInfo } from "@/services/inventory/types";
import { ALLOWED, refuse, type ThemeVerdict } from "./types";

/**
 * Whether a theme can be deleted without breaking the site.
 *
 * A parent theme reports status "inactive" while its child is the active
 * theme, so "inactive" alone is not a safe test — deleting the parent of an
 * active child takes the site down immediately. Four distinct refusals, each
 * with copy the UI can show verbatim.
 */
export function canDeleteTheme(themes: ThemeInfo[], slug: string): ThemeVerdict {
  const target = themes.find((t) => t.name === slug);
  if (!target) return refuse("That theme is not installed on this site.");

  // Snapshots taken before parentage was collected cannot be reasoned about.
  // Fail closed: one refresh is cheaper than an orphaned child theme.
  if (themes.some((t) => typeof t.template !== "string" || t.template === "")) {
    return refuse("Refresh the inventory first — this snapshot predates parent-theme tracking.");
  }

  if (themes.length <= 1) {
    return refuse("This is the only theme installed. WordPress needs one to fall back to.");
  }

  if (target.status === "active") {
    return refuse("This theme is active. Activate a different theme first.");
  }

  const active = themes.find((t) => t.status === "active");
  if (active && active.template === slug && active.name !== slug) {
    return refuse(`This is the parent of the active theme (${active.title || active.name}).`);
  }

  const child = themes.find((t) => t.name !== slug && t.template === slug);
  if (child) {
    return refuse(`This is the parent of ${child.title || child.name}, which would stop working.`);
  }

  return ALLOWED;
}

/** A child theme whose parent is absent produces a broken site on activation. */
export function canActivateTheme(themes: ThemeInfo[], slug: string): ThemeVerdict {
  const target = themes.find((t) => t.name === slug);
  if (!target) return refuse("That theme is not installed on this site.");

  const isChild = typeof target.template === "string" && target.template !== ""
    && target.template !== target.name;
  if (isChild && !themes.some((t) => t.name === target.template)) {
    return refuse(`Its parent theme (${target.template}) is not installed.`);
  }
  return ALLOWED;
}

/** Slugs that pass the delete gate — drives bulk-selection eligibility. */
export function deletableThemes(themes: ThemeInfo[]): string[] {
  return themes.filter((t) => canDeleteTheme(themes, t.name).allowed).map((t) => t.name);
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — all new cases plus the existing 163.

- [ ] **Step 6: Commit**

```bash
git add src/services/themes tests/theme-safety.test.ts
git commit -m "feat(themes): add delete and activate safety gates

A parent theme reports status inactive while its child is active, so
'inactive' is not a safe test for deletion. Four refusal reasons, and the
gate fails closed on snapshots that predate parentage tracking."
```

---

### Task 3: `delete_plugin` and `delete_theme` manage actions

**Files:**
- Modify: `src/services/manage/types.ts`
- Modify: `src/services/manage/service.ts`
- Test: `tests/manage-service.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `SLUG_RE`, `PLUGIN_FILE_RE`, `buildPhp` from `src/services/manage/service.ts`; `phpString` from `src/lib/wpphp.ts`.
- Produces: `ManageAction` variants `{ kind: "delete_plugin"; file: string }` and `{ kind: "delete_theme"; slug: string }`, handled by `buildPhp` and therefore by `manageSite`. Consumed by Tasks 5, 7 and 8.

- [ ] **Step 1: Write the failing test**

Add to `tests/manage-service.test.ts`:

```ts
import { buildPhp } from "@/services/manage/service";

describe("buildPhp — delete_plugin", () => {
  it("refuses to delete an active plugin, inside WordPress", () => {
    const php = buildPhp({ kind: "delete_plugin", file: "akismet/akismet.php" });
    expect(php).toContain("is_plugin_active");
    expect(php).toContain("delete_plugins");
  });

  it("passes the plugin file as base64, never interpolated", () => {
    const php = buildPhp({ kind: "delete_plugin", file: "akismet/akismet.php" });
    expect(php).not.toContain("akismet/akismet.php");
    expect(php).toContain(Buffer.from("akismet/akismet.php", "utf8").toString("base64"));
  });

  it("rejects a malformed plugin file", () => {
    expect(() => buildPhp({ kind: "delete_plugin", file: "../../evil.php" })).toThrow();
  });
});

describe("buildPhp — delete_theme", () => {
  it("re-checks parentage inside WordPress, not just in TypeScript", () => {
    const php = buildPhp({ kind: "delete_theme", slug: "storefront" });
    // The snapshot the UI gated on can be stale; WordPress is the authority.
    expect(php).toContain("get_stylesheet()");
    expect(php).toContain("get_template()");
    expect(php).toContain("delete_theme");
  });

  it("requires theme.php via a guard that is not a deprecated shim", () => {
    const php = buildPhp({ kind: "delete_theme", slug: "storefront" });
    expect(php).toContain("wp-admin/includes/theme.php");
    expect(php).not.toContain("function_exists('get_themes')");
  });

  it("rejects a malformed slug", () => {
    expect(() => buildPhp({ kind: "delete_theme", slug: "../evil" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/manage-service.test.ts`
Expected: FAIL — TypeScript rejects the unknown `kind` values, and `buildPhp` has no cases for them.

- [ ] **Step 3: Add the action variants**

In `src/services/manage/types.ts`:

```ts
export type ManageAction =
  | { kind: "update_core" }
  | { kind: "update_plugin"; file: string }
  | { kind: "update_all_plugins" }
  | { kind: "update_theme"; slug: string }
  | { kind: "activate_plugin"; file: string }
  | { kind: "deactivate_plugin"; file: string }
  | { kind: "delete_plugin"; file: string }
  | { kind: "activate_theme"; slug: string }
  | { kind: "delete_theme"; slug: string }
  | { kind: "maintenance"; enable: boolean }
  | { kind: "flush_cache" }
  | { kind: "flush_permalinks" };
```

- [ ] **Step 4: Implement the three new cases**

Add to the `switch` in `buildPhp` in `src/services/manage/service.ts`:

```ts
    case "delete_plugin":
      // delete_plugins() fires each plugin's uninstall hook, which routinely
      // drops its tables and options. The UI names that consequence; here we
      // only guarantee we never do it to a running plugin.
      return `
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
global $wp_filesystem; WP_Filesystem();
$f = ${phpString(pluginFile(action.file))};
if (!array_key_exists($f, get_plugins())) { return json_encode(array('ok' => false, 'error' => 'Plugin is not installed')); }
if (is_plugin_active($f) || is_plugin_active_for_network($f)) {
  return json_encode(array('ok' => false, 'error' => 'Deactivate the plugin before deleting it'));
}
$r = delete_plugins(array($f));
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) { return json_encode(array('ok' => false, 'error' => 'Delete failed (filesystem error)')); }
${OK("Plugin deleted")}`.trim();

    case "activate_theme":
      return `
require_once ABSPATH . 'wp-admin/includes/theme.php';
$s = ${phpString(themeSlug(action.slug))};
$t = wp_get_theme($s);
if (!$t->exists()) { return json_encode(array('ok' => false, 'error' => 'Theme is not installed')); }
$parent = $t->get_template();
if ($parent && $parent !== $s && !wp_get_theme($parent)->exists()) {
  return json_encode(array('ok' => false, 'error' => 'Parent theme ' . $parent . ' is not installed'));
}
switch_theme($s);
if (get_stylesheet() !== $s) { return json_encode(array('ok' => false, 'error' => 'WordPress did not switch themes')); }
${OK("Theme activated")}`.trim();

    case "delete_theme":
      // The gate also lives in TypeScript (services/themes/safety.ts) to drive
      // the UI, but that reads a snapshot which can be stale. This copy runs
      // against live state and is the one that actually protects the site.
      return `
require_once ABSPATH . 'wp-admin/includes/theme.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
global $wp_filesystem; WP_Filesystem();
$s = ${phpString(themeSlug(action.slug))};
$all = wp_get_themes();
if (!isset($all[$s])) { return json_encode(array('ok' => false, 'error' => 'Theme is not installed')); }
if (count($all) <= 1) { return json_encode(array('ok' => false, 'error' => 'This is the only theme installed')); }
if ($s === get_stylesheet()) { return json_encode(array('ok' => false, 'error' => 'Theme is active')); }
if ($s === get_template()) { return json_encode(array('ok' => false, 'error' => 'Theme is the parent of the active theme')); }
foreach ($all as $slug => $t) {
  if ($slug !== $s && $t->get_template() === $s) {
    return json_encode(array('ok' => false, 'error' => 'Theme is the parent of ' . $slug));
  }
}
$r = delete_theme($s);
if (is_wp_error($r)) { return json_encode(array('ok' => false, 'error' => $r->get_error_message())); }
if ($r === false || $r === null) { return json_encode(array('ok' => false, 'error' => 'Delete failed (filesystem error)')); }
${OK("Theme deleted")}`.trim();
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Verify the gate on a live site**

Confirm the authoritative PHP gate refuses the real case found during design. Against `staging.acad1.ph` (active theme `acad1-child`, parent `generatepress`), run the generated `delete_theme` PHP for `generatepress` and confirm it returns
`{"ok":false,"error":"Theme is the parent of the active theme"}` **without deleting anything**. Then confirm `wp_get_themes()` still lists `generatepress`.

- [ ] **Step 7: Commit**

```bash
git add src/services/manage tests/manage-service.test.ts
git commit -m "feat(manage): add delete_plugin, activate_theme, delete_theme

The theme delete gate is enforced inside WordPress against live state, not
only in TypeScript against a snapshot that may be stale."
```

---

### Task 4: Theme install service and storage bucket

**Files:**
- Create: `src/services/themes/install.ts`
- Create: `supabase/migrations/0005_storage_themes.sql`
- Modify: `src/lib/adapters/wporg.ts`
- Test: `tests/theme-install.test.ts`

**Interfaces:**
- Consumes: `phpString`, `SLUG_RE`, the `InstallSource` shape from `src/services/marketplace/install.ts`.
- Produces:
  - `buildThemeInstallPhp(source: InstallSource, activate: boolean): string`
  - `searchThemes(q: string): Promise<WpOrgThemeResult>` and `popularThemes()` in `wporg.ts`
  Consumed by Tasks 5, 8 and 9.

- [ ] **Step 1: Write the failing test**

Create `tests/theme-install.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildThemeInstallPhp } from "@/services/themes/install";

describe("buildThemeInstallPhp", () => {
  it("short-circuits when the theme is already installed", () => {
    // Theme_Upgrader::install() fails deterministically with folder_exists,
    // so retrying three times wastes six minutes to reach the same answer.
    const php = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, false);
    expect(php).toContain("wp_get_theme");
    expect(php).toContain("exists()");
  });

  it("resolves the download link through themes_api", () => {
    const php = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, false);
    expect(php).toContain("wp-admin/includes/theme-install.php");
    expect(php).toContain("themes_api");
  });

  it("passes the slug as base64", () => {
    const php = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, false);
    expect(php).not.toMatch(/'storefront'/);
    expect(php).toContain(Buffer.from("storefront", "utf8").toString("base64"));
  });

  it("overwrites only for uploads, never for wp.org installs", () => {
    const upload = buildThemeInstallPhp({ kind: "url", url: "https://x/t.zip" }, false);
    expect(upload).toContain("overwrite_package");
    const wporg = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, false);
    expect(wporg).not.toContain("overwrite_package");
  });

  it("activates through switch_theme when asked", () => {
    const php = buildThemeInstallPhp({ kind: "wporg", slug: "storefront" }, true);
    expect(php).toContain("switch_theme");
  });

  it("rejects a non-https upload URL", () => {
    expect(() => buildThemeInstallPhp({ kind: "url", url: "http://x/t.zip" }, false)).toThrow();
  });

  it("rejects a malformed slug", () => {
    expect(() => buildThemeInstallPhp({ kind: "wporg", slug: "../evil" }, false)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/theme-install.test.ts`
Expected: FAIL — `Cannot find module '@/services/themes/install'`.

- [ ] **Step 3: Write the install builder**

Create `src/services/themes/install.ts`:

```ts
import { phpString } from "@/lib/wpphp";
import { SLUG_RE } from "@/services/manage/service";
import type { InstallSource } from "@/services/marketplace/install";

export const THEME_INSTALL_TIMEOUT_MS = 300_000;

// Guarded on functions that genuinely live in these files. get_themes() is a
// deprecated always-loaded shim, so guarding on it silently skips the require.
const PRELUDE = `
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/template.php';
require_once ABSPATH . 'wp-admin/includes/theme.php';
require_once ABSPATH . 'wp-admin/includes/theme-install.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
global $wp_filesystem; WP_Filesystem();
`;

export function buildThemeInstallPhp(source: InstallSource, activate: boolean): string {
  const activatePhp = activate
    ? `
$stylesheet = $up->theme_info() ? $up->theme_info()->get_stylesheet() : null;
if (!$stylesheet) { return json_encode(array('ok' => true, 'message' => 'Installed (activation skipped: stylesheet unknown)')); }
switch_theme($stylesheet);
return json_encode(array('ok' => true, 'message' => 'Installed and activated', 'slug' => $stylesheet));`
    : `
return json_encode(array('ok' => true, 'message' => 'Theme installed'));`;

  let sourcePhp: string;
  if (source.kind === "wporg") {
    if (!SLUG_RE.test(source.slug)) throw new Error(`Invalid slug: ${JSON.stringify(source.slug)}`);
    const existingPhp = activate
      ? `
switch_theme($slug);
return json_encode(array('ok' => true, 'message' => 'Already installed — activated', 'slug' => $slug));`
      : `
return json_encode(array('ok' => true, 'message' => 'Already installed', 'slug' => $slug));`;
    sourcePhp = `
$slug = ${phpString(source.slug)};
if (wp_get_theme($slug)->exists()) {${existingPhp}
}
$api = themes_api('theme_information', array('slug' => $slug, 'fields' => array('sections' => false)));
if (is_wp_error($api)) { return json_encode(array('ok' => false, 'error' => 'wordpress.org lookup failed: ' . $api->get_error_message())); }
if (empty($api->download_link)) { return json_encode(array('ok' => false, 'error' => 'No download link for that theme')); }
$url = $api->download_link;
$installArgs = array();`;
  } else {
    if (!/^https:\/\//.test(source.url)) throw new Error("Install URL must be https");
    // Uploads are deliberate (re)installs, so overwriting is the intent.
    sourcePhp = `
$url = ${phpString(source.url)};
$installArgs = array('overwrite_package' => true);`;
  }

  return `${PRELUDE}${sourcePhp}
$up = new Theme_Upgrader(new Automatic_Upgrader_Skin());
$res = $up->install($url, $installArgs);
if (is_wp_error($res)) { return json_encode(array('ok' => false, 'error' => $res->get_error_message())); }
if ($res === false || $res === null) { return json_encode(array('ok' => false, 'error' => 'Install failed (filesystem error)')); }
${activatePhp}`.trim();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/theme-install.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the storage bucket migration**

Create `supabase/migrations/0005_storage_themes.sql`:

```sql
-- Private bucket for uploaded theme .zip files, mirroring the plugins bucket.
-- The browser uploads to a signed URL; the server hands WordPress a separate
-- short-lived signed download URL. Nothing is ever public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('themes', 'themes', false, 52428800, array['application/zip','application/x-zip-compressed','application/octet-stream'])
on conflict (id) do nothing;
```

- [ ] **Step 6: Add theme search to the wp.org adapter**

In `src/lib/adapters/wporg.ts`, mirror the existing plugin functions using the
themes endpoint `https://api.wordpress.org/themes/info/1.2/?action=query_themes`.
Follow the shape of `searchPlugins` / `popularPlugins` exactly — same timeout,
same error handling, same result normalisation. Export:

```ts
export interface WpOrgTheme {
  slug: string;
  name: string;
  version: string;
  author: string;
  preview_url: string | null;
  screenshot_url: string | null;
  rating: number;
  num_ratings: number;
  active_installs: number;
}
export interface WpOrgThemeResult { themes: WpOrgTheme[]; total: number }
export async function searchThemes(q: string): Promise<WpOrgThemeResult>
export async function popularThemes(): Promise<WpOrgThemeResult>
```

The themes API returns `author` as an **object** (`{ user_nicename, display_name, … }`)
where the plugins API returns a string. Rendering that object into JSX throws
"Objects are not valid as a React child", so normalise it in the adapter:

```ts
const THEMES_API = "https://api.wordpress.org/themes/info/1.2/";

const FIELDS = {
  slug: true, name: true, version: true, author: true, screenshot_url: true,
  rating: true, num_ratings: true, active_installs: true, preview_url: true,
  sections: false, description: false, tags: false, homepage: false,
};

interface RawTheme {
  slug: string; name: string; version: string;
  author: string | { display_name?: string; user_nicename?: string };
  screenshot_url?: string; preview_url?: string;
  rating?: number; num_ratings?: number; active_installs?: number;
}

/** The themes endpoint returns an author object; the plugins one a string.
 *  Exported so the normalisation can be tested without a network call. */
export function authorName(a: RawTheme["author"]): string {
  if (typeof a === "string") return a.replace(/<[^>]*>/g, "").trim();
  return (a?.display_name ?? a?.user_nicename ?? "Unknown").trim();
}

function normalise(t: RawTheme): WpOrgTheme {
  return {
    slug: t.slug,
    name: t.name,
    version: t.version,
    author: authorName(t.author),
    // The API returns protocol-relative URLs ("//ts.w.org/..."), which break
    // in an <img src> on some browsers; force https.
    screenshot_url: t.screenshot_url ? t.screenshot_url.replace(/^\/\//, "https://") : null,
    preview_url: t.preview_url ?? null,
    rating: t.rating ?? 0,
    num_ratings: t.num_ratings ?? 0,
    active_installs: t.active_installs ?? 0,
  };
}

async function query(params: Record<string, unknown>): Promise<WpOrgThemeResult> {
  const url = `${THEMES_API}?action=query_themes&request=${encodeURIComponent(
    JSON.stringify({ per_page: 24, fields: FIELDS, ...params }),
  )}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`wordpress.org returned HTTP ${res.status}`);
  const json = (await res.json()) as { themes?: RawTheme[]; info?: { results?: number } };
  return {
    themes: (json.themes ?? []).map(normalise),
    total: json.info?.results ?? 0,
  };
}

export const searchThemes = (q: string) => query({ search: q });
export const popularThemes = () => query({ browse: "popular" });
```

Add a test asserting `authorName` flattens the object form — that is the defect
this normalisation exists to prevent:

```ts
import { authorName } from "@/lib/adapters/wporg";

it("flattens the themes API author object to a string", () => {
  expect(authorName({ display_name: "Automattic" })).toBe("Automattic");
  expect(authorName({ user_nicename: "wordpressdotorg" })).toBe("wordpressdotorg");
  expect(authorName("<a href='#'>Someone</a>")).toBe("Someone");
});
```

- [ ] **Step 7: Run all tests and commit**

```bash
npm test
git add src/services/themes/install.ts src/lib/adapters/wporg.ts supabase/migrations/0005_storage_themes.sql tests/theme-install.test.ts
git commit -m "feat(themes): install from wordpress.org or an uploaded zip"
```

- [ ] **Step 8: Apply the migration**

Run `supabase/migrations/0005_storage_themes.sql` in the Supabase SQL editor. Theme upload fails with "Bucket not found" until this is applied.

---

### Task 5: Bulk eligibility, job type and handler

**Files:**
- Create: `src/services/bulk/types.ts`
- Create: `src/services/bulk/service.ts`
- Modify: `src/services/jobs/types.ts`
- Modify: `src/services/jobs/handlers.ts`
- Modify: `src/app/api/batches/[id]/route.ts`
- Test: `tests/bulk-service.test.ts`

**Interfaces:**
- Consumes: `ManageAction` (Task 3), `canDeleteTheme` / `deletableThemes` (Task 2), `enqueueJob` from `src/services/jobs/service.ts`, `manageSite` from `src/services/manage/service.ts`.
- Produces:
  - `type BulkKind = "update" | "activate" | "deactivate" | "delete"`
  - `type BulkTarget = "plugin" | "theme"`
  - `interface BulkItem { id: string; label: string }`
  - `interface BulkSplit { included: BulkItem[]; excluded: Array<BulkItem & { reason: string }> }`
  - `interface BulkJobPayload { kind: BulkKind; target: BulkTarget; id: string; label: string }`
  - `toManageAction(kind: BulkKind, target: BulkTarget, id: string): ManageAction`
  - `splitEligible(kind: BulkKind, target: BulkTarget, inv: InventoryPayload, ids: string[]): BulkSplit`
  - `enqueueBulk(deps: BulkDeps, siteId: string, actorId: string, kind: BulkKind, target: BulkTarget, inv: InventoryPayload, ids: string[]): Promise<{ batchId: string | null; split: BulkSplit }>`
  - `interface BulkDeps { jobs: JobsRepo; sites: SitesRepo }`
  Consumed by Tasks 7 and 8.

- [ ] **Step 1: Write the failing test**

Create `tests/bulk-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitEligible, toManageAction } from "@/services/bulk/service";
import type { InventoryPayload } from "@/services/inventory/types";

const inv = (over: Partial<InventoryPayload> = {}): InventoryPayload => ({
  collected_at: "2026-08-29T00:00:00.000Z",
  wp_version: "7.1",
  php_version: "8.3",
  admin_url: "https://x/wp-admin/",
  core_update: null,
  plugins: [
    { file: "a/a.php", name: "a", version: "1", status: "active", update: "available", update_version: "2" },
    { file: "b/b.php", name: "b", version: "1", status: "inactive", update: "none" },
  ],
  themes: [
    { name: "child", template: "parent", version: "1", status: "active", update: "none" },
    { name: "parent", template: "parent", version: "1", status: "inactive", update: "available", update_version: "2" },
    { name: "spare", template: "spare", version: "1", status: "inactive", update: "none" },
  ],
  admin_users: [],
  ...over,
});

describe("splitEligible — plugins", () => {
  it("excludes an active plugin from delete, with a reason", () => {
    const s = splitEligible("delete", "plugin", inv(), ["a/a.php", "b/b.php"]);
    expect(s.included.map((i) => i.id)).toEqual(["b/b.php"]);
    expect(s.excluded[0].reason).toMatch(/active/i);
  });

  it("excludes a plugin with no update from update", () => {
    const s = splitEligible("update", "plugin", inv(), ["a/a.php", "b/b.php"]);
    expect(s.included.map((i) => i.id)).toEqual(["a/a.php"]);
  });

  it("excludes an already-active plugin from activate", () => {
    const s = splitEligible("activate", "plugin", inv(), ["a/a.php", "b/b.php"]);
    expect(s.included.map((i) => i.id)).toEqual(["b/b.php"]);
  });
});

describe("splitEligible — themes", () => {
  it("excludes the parent of the active theme from delete", () => {
    const s = splitEligible("delete", "theme", inv(), ["parent", "spare"]);
    expect(s.included.map((i) => i.id)).toEqual(["spare"]);
    expect(s.excluded[0].reason).toMatch(/parent/i);
  });

  it("keeps the delete reason from the theme safety gate", () => {
    const s = splitEligible("delete", "theme", inv(), ["child"]);
    expect(s.included).toEqual([]);
    expect(s.excluded[0].reason).toMatch(/active/i);
  });
});

describe("toManageAction", () => {
  it("maps each bulk kind onto the matching manage action", () => {
    expect(toManageAction("delete", "plugin", "a/a.php")).toEqual({ kind: "delete_plugin", file: "a/a.php" });
    expect(toManageAction("update", "theme", "spare")).toEqual({ kind: "update_theme", slug: "spare" });
    expect(toManageAction("activate", "theme", "spare")).toEqual({ kind: "activate_theme", slug: "spare" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/bulk-service.test.ts`
Expected: FAIL — `Cannot find module '@/services/bulk/service'`.

- [ ] **Step 3: Write the types**

Create `src/services/bulk/types.ts`:

```ts
export type BulkKind = "update" | "activate" | "deactivate" | "delete";
export type BulkTarget = "plugin" | "theme";

export interface BulkItem { id: string; label: string }
export interface BulkExclusion extends BulkItem { reason: string }
export interface BulkSplit { included: BulkItem[]; excluded: BulkExclusion[] }

/** Job payload — one job per target, all sharing a batch_id. */
export interface BulkJobPayload {
  kind: BulkKind;
  target: BulkTarget;
  id: string;
  /** Display name captured at enqueue time, so the batch view can name the
   *  item even if the inventory changes underneath it. */
  label: string;
}
```

- [ ] **Step 4: Write the service**

Create `src/services/bulk/service.ts`:

```ts
import type { InventoryPayload } from "@/services/inventory/types";
import type { ManageAction } from "@/services/manage/types";
import { canDeleteTheme } from "@/services/themes/safety";
import { enqueueJob } from "@/services/jobs/service";
import type { JobsRepo } from "@/services/jobs/repo";
import type { SitesRepo } from "@/services/sites/repo";
import type { BulkKind, BulkSplit, BulkTarget } from "./types";

export function toManageAction(kind: BulkKind, target: BulkTarget, id: string): ManageAction {
  if (target === "plugin") {
    switch (kind) {
      case "update": return { kind: "update_plugin", file: id };
      case "activate": return { kind: "activate_plugin", file: id };
      case "deactivate": return { kind: "deactivate_plugin", file: id };
      case "delete": return { kind: "delete_plugin", file: id };
    }
  }
  switch (kind) {
    case "update": return { kind: "update_theme", slug: id };
    case "activate": return { kind: "activate_theme", slug: id };
    case "delete": return { kind: "delete_theme", slug: id };
    // Themes are switched, never deactivated; the UI never offers this.
    case "deactivate": throw new Error("Themes cannot be deactivated");
  }
}

/**
 * Partition a selection into what will run and what will be skipped, with a
 * reason for every exclusion. A bulk action never silently drops items.
 */
export function splitEligible(
  kind: BulkKind, target: BulkTarget, inv: InventoryPayload, ids: string[],
): BulkSplit {
  const split: BulkSplit = { included: [], excluded: [] };

  for (const id of ids) {
    if (target === "plugin") {
      const p = inv.plugins.find((x) => x.file === id);
      const label = p?.title || p?.name || id;
      if (!p) { split.excluded.push({ id, label, reason: "No longer installed." }); continue; }
      if (kind === "update" && p.update !== "available") {
        split.excluded.push({ id, label, reason: "Already up to date." }); continue;
      }
      if (kind === "activate" && p.status === "active") {
        split.excluded.push({ id, label, reason: "Already active." }); continue;
      }
      if (kind === "deactivate" && p.status !== "active") {
        split.excluded.push({ id, label, reason: "Already inactive." }); continue;
      }
      if (kind === "delete" && p.status === "active") {
        split.excluded.push({ id, label, reason: "Deactivate it before deleting." }); continue;
      }
      split.included.push({ id, label });
      continue;
    }

    const t = inv.themes.find((x) => x.name === id);
    const label = t?.title || t?.name || id;
    if (!t) { split.excluded.push({ id, label, reason: "No longer installed." }); continue; }
    if (kind === "update" && t.update !== "available") {
      split.excluded.push({ id, label, reason: "Already up to date." }); continue;
    }
    if (kind === "activate" && t.status === "active") {
      split.excluded.push({ id, label, reason: "Already active." }); continue;
    }
    if (kind === "delete") {
      // Reuse the gate rather than restating it — one definition of "safe".
      const verdict = canDeleteTheme(inv.themes, id);
      if (!verdict.allowed) {
        split.excluded.push({ id, label, reason: verdict.reason }); continue;
      }
    }
    split.included.push({ id, label });
  }

  return split;
}

export interface BulkDeps { jobs: JobsRepo; sites: SitesRepo }

/** Enqueue one job per eligible item, all sharing a batch id. */
export async function enqueueBulk(
  deps: BulkDeps, siteId: string, actorId: string,
  kind: BulkKind, target: BulkTarget, inv: InventoryPayload, ids: string[],
): Promise<{ batchId: string | null; split: BulkSplit }> {
  const split = splitEligible(kind, target, inv, ids);
  if (split.included.length === 0) return { batchId: null, split };

  const batchId = crypto.randomUUID();
  for (const item of split.included) {
    await deps.jobs.insert({
      type: "bulk_manage", site_id: siteId, batch_id: batchId,
      payload: { kind, target, id: item.id, label: item.label },
    });
  }
  await deps.sites.insertActivity({
    actor: actorId, site_id: siteId, action: `site.bulk.${target}.${kind}`,
    detail: { queued: split.included.length, skipped: split.excluded.length },
  });
  return { batchId, split };
}
```

- [ ] **Step 5: Register the job type and handler**

In `src/services/jobs/types.ts` add `"bulk_manage"` to `JobType`.

In `src/services/jobs/handlers.ts`, add a handler alongside the existing ones. Follow the shape of the `plugin_install` handler exactly:

```ts
    bulk_manage: async (job) => {
      const p = job.payload as unknown as BulkJobPayload;
      if (!job.site_id) throw new Error("bulk_manage requires a site_id");
      const action = toManageAction(p.kind, p.target, p.id);
      const result = await manageSite(
        { sites: supabaseSitesRepo(db), jobs: supabaseJobsRepo(db), mcp: createSiteMcpClient },
        job.site_id, SYSTEM_ACTOR, action,
      );
      // Throwing puts the job on the retry ladder; a failing item must never
      // abort its siblings, which are separate jobs.
      if (!result.ok) throw new Error(result.error ?? "Bulk action failed");
    },
```

Use whatever the file already uses for the system actor id — match the existing handlers rather than inventing a new constant.

- [ ] **Step 6: Add the batch label**

In `src/app/api/batches/[id]/route.ts`, add a `label` to each row. The batch view was built for one-plugin-many-sites; a bulk batch is one-site-many-items, so labelling every row with the same site name is useless:

```ts
  const rows = jobs.map((j) => {
    const siteName = j.site_id ? names.get(j.site_id) ?? j.site_id : "—";
    const payloadLabel = (j.payload as { label?: unknown }).label;
    return {
      id: j.id,
      site_id: j.site_id,
      site_name: siteName,
      // Bulk batches are one site, many items; install batches are one item,
      // many sites. The payload label distinguishes them.
      label: typeof payloadLabel === "string" && payloadLabel ? payloadLabel : siteName,
      status: j.status,
      attempts: j.attempts,
      last_error: j.last_error,
    };
  });
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/bulk src/services/jobs "src/app/api/batches" tests/bulk-service.test.ts
git commit -m "feat(bulk): queue-backed bulk actions with per-item eligibility

One job per target sharing a batch id, so a failing item retries on the
normal ladder without aborting its siblings. Every excluded item carries a
reason rather than being silently dropped."
```

---

### Task 6: Selection UI primitives

**Files:**
- Create: `src/components/ui/selection.tsx`
- Modify: `src/app/globals.css` (only if a new utility is genuinely needed)

**Interfaces:**
- Consumes: `buttonClass`, `cardClass` from `src/components/ui/styles.ts`; icons from `src/components/ui/icons.tsx`.
- Produces:
  - `useSelection(allIds: string[])` → `{ selected, isSelected, toggle, toggleAll, clear, allChecked, someChecked }`
  - `<RowCheckbox checked onChange label />`
  - `<SelectAllCheckbox allChecked someChecked onChange count />`
  - `<BulkBar count actions onClear />` where `actions: Array<{ key, label, tone?, onClick, disabled?, disabledReason? }>`
  Consumed by Tasks 7 and 8.

- [ ] **Step 1: Write the component**

Create `src/components/ui/selection.tsx` as a client component.

Requirements, each of which is a real defect if missed:

- The select-all checkbox must set `indeterminate` via a ref — it is a DOM property, not an attribute, and cannot be set through JSX.
- Every checkbox needs an accessible name. In a table row use a visually hidden label naming the row's item, not a bare checkbox.
- The bulk bar is `position: sticky; bottom: 0` inside the page, not `fixed`, so it never covers the toast region (which is `fixed` bottom-right).
- A disabled bulk action shows *why* on hover and to screen readers via `title` + `aria-describedby`, rather than being inert with no explanation.
- Follow `DESIGN.md`: `rounded-2xl` controls, `accent-ink` checkboxes, hairline borders, `shadow-raised` on the bar, `min-h-10` touch targets, and the bar must reflow to stacked layout at 375px.

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export function useSelection(allIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Ids can disappear when the inventory refreshes; a selection referring to a
  // deleted plugin would enqueue a job for something that no longer exists.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => allIds.includes(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [allIds]);

  return useMemo(() => {
    const isSelected = (id: string) => selected.has(id);
    const toggle = (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    const toggleAll = () =>
      setSelected((prev) => (prev.size === allIds.length ? new Set() : new Set(allIds)));
    return {
      selected: [...selected],
      isSelected,
      toggle,
      toggleAll,
      clear: () => setSelected(new Set()),
      allChecked: allIds.length > 0 && selected.size === allIds.length,
      someChecked: selected.size > 0 && selected.size < allIds.length,
    };
  }, [selected, allIds]);
}
```

Then the three components. `indeterminate` is a DOM property with no JSX
attribute, so it must be set through a ref — this is the step that is silently
skipped and leaves the header checkbox showing "none selected" when a partial
selection exists:

```tsx
export function SelectAllCheckbox({
  allChecked, someChecked, onChange, label = "Select all rows",
}: { allChecked: boolean; someChecked: boolean; onChange: () => void; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  // There is no `indeterminate` HTML attribute — only the DOM property.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someChecked;
  }, [someChecked]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allChecked}
      onChange={onChange}
      aria-label={label}
      className="size-4 shrink-0 rounded-md accent-ink"
    />
  );
}

export function RowCheckbox({
  checked, onChange, label,
}: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      // Naming the row's item, so a screen reader announces what is being
      // selected rather than "checkbox, checkbox, checkbox".
      aria-label={`Select ${label}`}
      className="size-4 shrink-0 rounded-md accent-ink"
    />
  );
}

export interface BulkAction {
  key: string;
  label: string;
  tone?: "default" | "danger";
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function BulkBar({
  count, actions, onClear,
}: { count: number; actions: BulkAction[]; onClear: () => void }) {
  if (count === 0) return null;
  return (
    // Sticky, not fixed: the toast region is fixed at bottom-right, and a
    // fixed bar would sit on top of the notification confirming the action.
    <div
      className="sticky bottom-0 z-20 mt-4 flex flex-col gap-3 rounded-3xl border border-hairline
        bg-paper p-4 shadow-raised sm:flex-row sm:items-center sm:justify-between"
      role="region"
      aria-label="Bulk actions"
    >
      <p className="text-body text-ink" aria-live="polite">
        {count} selected
      </p>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            disabled={a.disabled}
            title={a.disabled ? a.disabledReason : undefined}
            aria-label={a.disabled && a.disabledReason ? `${a.label} — ${a.disabledReason}` : undefined}
            className={buttonClass(a.tone === "danger" ? "danger" : "outline", "sm")}
          >
            {a.label}
          </button>
        ))}
        <button type="button" onClick={onClear} className={buttonClass("ghost", "sm")}>
          Clear
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles and the detector is clean**

```bash
npx tsc --noEmit
node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json src/components/ui/selection.tsx
```
Expected: no type errors; detector returns `[]`.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/selection.tsx
git commit -m "feat(ui): add row selection and bulk action bar primitives"
```

---

### Task 7: Plugins tab — selection, bulk actions, delete

**Files:**
- Modify: `src/app/(dashboard)/sites/[id]/plugins/page.tsx`
- Create: `src/app/(dashboard)/sites/[id]/plugins/plugin-table.tsx`
- Create: `src/app/(dashboard)/sites/[id]/bulk-actions.ts`

**Interfaces:**
- Consumes: `useSelection`/`BulkBar` (Task 6), `splitEligible`/`enqueueBulk` (Task 5), `ManageForm` (existing).
- Produces: `bulkAction(siteId, kind, target, ids, prevState?, formData?)` server action returning `{ ok: boolean; batchId?: string; queued?: number; skipped?: number; error?: string }`. Consumed by Task 8's theme table as well.

The page stays a Server Component that loads the snapshot; the table becomes a Client Component because selection is client state.

- [ ] **Step 1: Write the server action**

Create `src/app/(dashboard)/sites/[id]/bulk-actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { enqueueBulk } from "@/services/bulk/service";
import type { BulkKind, BulkTarget } from "@/services/bulk/types";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

export async function bulkAction(
  siteId: string, kind: BulkKind, target: BulkTarget, ids: string[],
  _prevState?: { ok: boolean; error?: string } | null,
  _formData?: FormData,
): Promise<{ ok: boolean; batchId?: string; queued?: number; skipped?: number; error?: string }> {
  const user = await requireUser();
  if (ids.length === 0) return { ok: false, error: "Nothing selected" };
  if (ids.length > 50) return { ok: false, error: "Select 50 items or fewer" };

  const db = createServiceSupabase();
  // Eligibility is judged against the stored snapshot, which is what the user
  // was looking at. Each job re-checks against live state when it runs.
  const snapshot = await supabaseSnapshotsRepo(db).latestSnapshot(siteId);
  if (!snapshot) return { ok: false, error: "Refresh the inventory first" };

  try {
    const { batchId, split } = await enqueueBulk(
      { jobs: supabaseJobsRepo(db), sites: supabaseSitesRepo(db) },
      siteId, user.id, kind, target, snapshot.payload, ids,
    );
    revalidatePath(`/sites/${siteId}/${target === "plugin" ? "plugins" : "themes"}`);
    if (!batchId) {
      return { ok: false, error: `Nothing eligible — ${split.excluded[0]?.reason ?? "all items skipped"}` };
    }
    return { ok: true, batchId, queued: split.included.length, skipped: split.excluded.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not queue the bulk action" };
  }
}
```

- [ ] **Step 2: Build the client table**

Create `plugin-table.tsx` — a Client Component receiving `siteId` and `plugins: PluginInfo[]`.

- Renders the existing table markup (keep the current styling and per-row `ManageForm` actions untouched) plus a leading checkbox column.
- `useSelection(plugins.map(p => p.file))`.
- `BulkBar` offering Update / Activate / Deactivate / Delete, each disabled with a reason when nothing in the selection is eligible — compute with `splitEligible` on the client so the bar explains itself before submitting.
- Clicking a bulk action opens a `ConfirmDialog` listing the affected plugin names, and for Delete states the consequence verbatim:

  > "Deleting runs each plugin's uninstall routine, which usually removes its database tables and settings. This cannot be undone."

- On confirm, call `bulkAction(...)` in a transition. On success, toast `Queued N items` (mentioning skipped count when non-zero) and `router.push(/marketplace/batches/${batchId})`.

- [ ] **Step 3: Add the single-plugin delete action**

In the per-row actions, add a Delete `ManageForm` for inactive plugins only, using
`manageAction.bind(null, id, { kind: "delete_plugin", file: p.file })`, `variant="danger"`, and the same uninstall-consequence copy in its confirm dialog.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm test && npm run build
node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json "src/app/(dashboard)/sites/[id]/plugins"
```
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/sites/[id]"
git commit -m "feat(plugins): row selection, bulk actions, and delete"
```

---

### Task 8: Themes tab — full CRUD, selection, bulk, per-site installer

**Files:**
- Modify: `src/app/(dashboard)/sites/[id]/themes/page.tsx`
- Create: `src/app/(dashboard)/sites/[id]/themes/theme-table.tsx`
- Create: `src/app/(dashboard)/sites/[id]/themes/install-panel.tsx`
- Create: `src/app/(dashboard)/sites/[id]/themes/theme-actions.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 4, 5, 6.
- Produces: `installThemeAction(siteId, prevState, formData)` and `prepareThemeUploadAction(fileName)`, mirroring the marketplace upload actions.

- [ ] **Step 1: Theme table with selection and CRUD**

`theme-table.tsx`, a Client Component, mirroring Task 7's plugin table:

- Checkbox column, `useSelection(themes.map(t => t.name))`.
- Per-row: **Activate** (inactive themes passing `canActivateTheme`), **Update** (when available), **Delete** (only when `canDeleteTheme` allows).
- A refused theme shows no Delete button and instead a muted note carrying the gate's reason — the parent-theme case must read as an explanation, not a missing feature. Example: "Parent of ACAD1 Review Center".
- `BulkBar` offering Update and Delete only. Themes are switched, never deactivated, and activating many themes is meaningless — do not offer either.
- Delete confirm lists names and notes that theme files are removed from the server.

- [ ] **Step 2: Per-site install panel**

`install-panel.tsx`, a Client Component with two modes in one card:

- **From wordpress.org** — a slug/search input calling `searchThemes`, results as a compact list with an Install button each.
- **Upload .zip** — file input, 50MB cap, `.zip` only, uploading to the `themes` bucket via `prepareThemeUploadAction` + `uploadToSignedUrl`, exactly as `upload-card.tsx` does for plugins.
- An "Activate after install" checkbox.
- Both paths call `installThemeAction`, which enqueues a `plugin_install`-style job or runs inline; follow whichever the marketplace install already does for a single site so behaviour matches.

- [ ] **Step 3: Wire the page**

`themes/page.tsx` stays a Server Component: loads the snapshot, renders `SiteTabs`, the refresh control, `<ThemeTable>`, `<InstallPanel>`, and the existing child-theme card unchanged.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm test && npm run build
node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json "src/app/(dashboard)/sites/[id]/themes"
```

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/sites/[id]/themes"
git commit -m "feat(themes): full CRUD, selection, bulk actions, per-site installer"
```

---

### Task 9: Marketplace themes surface and wp-admin button

**Files:**
- Create: `src/app/(dashboard)/marketplace/themes/page.tsx`
- Modify: `src/app/(dashboard)/marketplace/page.tsx`
- Modify: `src/app/(dashboard)/marketplace/install-panel.tsx` (accept a `target` prop)
- Modify: `src/app/(dashboard)/sites/[id]/page.tsx`
- Modify: `src/app/(dashboard)/marketplace/batches/[id]/poller.tsx`

- [ ] **Step 1: Marketplace navigation**

Add a Plugins / Themes segmented control to both marketplace pages, styled as the `SiteTabs` strip is (`bg-canvas` container, active pill on `bg-paper` with `shadow-subtle`). `/marketplace` stays plugins; `/marketplace/themes` is the new themes surface.

- [ ] **Step 2: Themes marketplace page**

Mirror `marketplace/page.tsx`: search form, theme cards (screenshot, name, author, rating, installs), and a multi-site install panel per theme. Reuse `InstallPanel` with a `target: "theme"` prop so the batch machinery is shared; the install job routes to `buildThemeInstallPhp` when the target is a theme.

Theme screenshots are remote images from `ts.w.org`. Use a plain `<img>` with an eslint-disable comment, as the plugin cards already do, rather than configuring `next/image` remote patterns for one surface.

- [ ] **Step 3: Batch poller label**

Change the poller's first column header from "Site" to "Item" and render `j.label` (Task 5, step 6) instead of `j.site_name`. Update the `BatchJob` interface to include `label: string`.

- [ ] **Step 4: wp-admin button**

On the site overview header, beside "Test connection", add:

```tsx
<a
  href={inv?.admin_url ?? `${site.url.replace(/\/+$/, "")}/wp-admin/`}
  target="_blank"
  rel="noopener noreferrer"
  className={buttonClass("outline")}
>
  <IconExternal size={16} />
  Open wp-admin
</a>
```

Below it, show the WordPress username with a copy control so a password manager has what it needs:

```tsx
<CopyValueButton value={site.wp_username} label="Copy WP username" />
```

`CopyLinkButton` copies an origin-relative path, so add a sibling `CopyValueButton` in `src/components/ui/copy-button.tsx` that copies a literal string. Do not overload the existing one.

Add a one-line note near the button: WordPress application passwords cannot log in to wp-admin (verified — see the spec), so the operator signs in normally.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npm test && npm run build
node "C:/Users/raroc/.claude/skills/impeccable/scripts/detect.mjs" --json "src/app/(dashboard)/marketplace" "src/app/(dashboard)/sites/[id]/page.tsx" src/components/ui
```

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)" src/components/ui
git commit -m "feat(marketplace): theme browser, batch item labels, wp-admin link"
```

---

### Task 10: Live verification and documentation

Unit tests cannot prove any of this works against real WordPress. Every earlier phase found a defect at exactly this step.

**Files:**
- Create: `docs/ops/themes.md`
- Modify: `README.md` (features list)

- [ ] **Step 1: Verify the destructive gate refuses**

Against `staging.acad1.ph` (active theme `acad1-child`, parent `generatepress`):

1. Themes tab shows **no** Delete button on `generatepress`, and the reason names the child theme.
2. Selecting `generatepress` and choosing bulk Delete leaves it excluded with that reason and enqueues nothing.
3. `generatepress` is still installed afterwards.

- [ ] **Step 2: Verify the full theme lifecycle**

On the same staging site: install `twentytwentyfour` from wordpress.org, confirm it appears; update it if an update exists; delete it; confirm it is gone. Then upload a `.zip` and confirm it installs.

- [ ] **Step 3: Verify bulk actions end to end**

Select two or more inactive plugins, run bulk Update, confirm the batch page lists them **by plugin name** (not by site name), and that they reach `done`. Locally, press "Process queue now" to drain.

- [ ] **Step 4: Verify plugin delete**

Delete one inactive, disposable plugin on staging. Confirm the confirm dialog names the uninstall consequence, and that the plugin is gone from disk after the inventory refresh.

- [ ] **Step 5: Verify wp-admin and responsiveness**

Confirm the button opens the correct admin URL in a new tab, and check the plugins and themes tables plus the bulk bar at 375px with no horizontal overflow.

- [ ] **Step 6: Write the ops doc**

`docs/ops/themes.md`: the four delete refusal reasons and why each exists; that bulk actions run through the job queue and need the scheduler (or "Process queue now" locally); that theme uploads need migration `0005`; and that application passwords cannot log in to wp-admin, with the measured evidence from the spec.

- [ ] **Step 7: Commit**

```bash
git add docs/ops/themes.md README.md
git commit -m "docs: theme management and bulk action operations"
```

---

## Definition of done

- `npx tsc --noEmit` clean, `npm run build` clean, `npm test` green with no fewer than 163 tests.
- Impeccable detector returns `[]` for every changed UI file; no horizontal overflow at 375px.
- The parent-theme delete refusal is verified on a live site, in the UI and in the bulk path.
- A theme has been installed, updated and deleted against a live site.
- A bulk batch has completed with per-item labels visible.
- Migration `0005_storage_themes.sql` applied.
