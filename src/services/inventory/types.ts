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
  core_update: string | null;
  plugins: PluginInfo[];
  themes: ThemeInfo[];
  admin_users: AdminUser[];
}

export function pendingUpdates(p: InventoryPayload): number {
  const plugins = p.plugins.filter((x) => x.update === "available").length;
  const themes = p.themes.filter((x) => x.update === "available").length;
  return plugins + themes + (p.core_update ? 1 : 0);
}
