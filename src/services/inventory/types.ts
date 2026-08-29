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
  core_update: string | null;
  plugins: PluginInfo[];
  themes: ThemeInfo[];
}

export function pendingUpdates(p: InventoryPayload): number {
  const plugins = p.plugins.filter((x) => x.update === "available").length;
  const themes = p.themes.filter((x) => x.update === "available").length;
  return plugins + themes + (p.core_update ? 1 : 0);
}
