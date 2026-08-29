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
