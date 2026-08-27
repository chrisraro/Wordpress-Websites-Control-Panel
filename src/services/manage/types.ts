export type ManageAction =
  | { kind: "update_core" }
  | { kind: "update_plugin"; slug: string }
  | { kind: "update_all_plugins" }
  | { kind: "update_theme"; slug: string }
  | { kind: "activate_plugin"; slug: string }
  | { kind: "deactivate_plugin"; slug: string }
  | { kind: "maintenance"; enable: boolean }
  | { kind: "flush_cache" }
  | { kind: "flush_permalinks" };
