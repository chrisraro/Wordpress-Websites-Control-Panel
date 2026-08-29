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
