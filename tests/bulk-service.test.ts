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
