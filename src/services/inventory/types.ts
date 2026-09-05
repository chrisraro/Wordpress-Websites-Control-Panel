import type { GscVerification } from "@/services/gsc/types";
export interface PluginInfo {
  /** Plugin basename, e.g. "akismet/akismet.php" — the identifier WP APIs use */
  file: string;
  /** Directory slug, e.g. "akismet" — for display and wp.org lookups */
  name: string;
  title?: string;
  version: string;
  status: string;
  update: string;
  update_version?: string | null;
}
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
export interface AdminUser { ID: number; user_login: string; user_email: string }

export interface InventoryPayload {
  collected_at: string;
  wp_version: string;
  php_version: string;
  /** WordPress's own admin_url() — correct for subdirectory installs. */
  admin_url: string;
  /**
   * Whether ABSPATH/.maintenance exists right now.
   *
   * Optional because snapshots collected before this field existed have no
   * value for it, and `undefined` has to keep meaning "not measured" rather
   * than collapsing into `false`. Reporting "Live" for a site that is
   * actually behind a maintenance page would be worse than saying nothing.
   */
  maintenance?: boolean;
  core_update: string | null;
  /**
   * Google Search Console verification found on the site.
   *
   * Collected here rather than by a separate probe because it rides the
   * inventory's existing round trip for free, and because the dashboard
   * already loads the latest snapshot for every site — a badge on twelve
   * rows costs nothing extra this way, where twelve live MCP calls would
   * make the page unusable.
   *
   * Optional for the same reason `maintenance` is: snapshots taken before
   * this existed have no value, and `undefined` must keep meaning "not
   * measured" rather than collapsing into "nothing installed". Telling
   * someone their verification is missing when it was simply never looked
   * for sends them to fix something that may not be broken.
   */
  gsc?: GscVerification;
  plugins: PluginInfo[];
  themes: ThemeInfo[];
}

/**
 * Plugins with an update available, and nothing else.
 *
 * Distinct from `pendingUpdates`, which also counts themes and core — the
 * right number for "does this site need attention", and the wrong one for
 * anything that acts on plugins specifically. A control that queued a plugin
 * update for a site whose only pending update was a theme would promise work
 * it cannot do and report "Nothing to update" for its trouble.
 */
export function pendingPluginUpdates(p: InventoryPayload): number {
  return p.plugins.filter((x) => x.update === "available").length;
}

export function pendingUpdates(p: InventoryPayload): number {
  const plugins = p.plugins.filter((x) => x.update === "available").length;
  const themes = p.themes.filter((x) => x.update === "available").length;
  return plugins + themes + (p.core_update ? 1 : 0);
}
