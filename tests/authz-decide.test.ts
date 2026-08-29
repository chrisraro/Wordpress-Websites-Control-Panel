import { describe, expect, it } from "vitest";
import { can, canAccessSite, visibleSiteIds } from "@/lib/authz/decide";
import type { Viewer } from "@/lib/authz/decide";
import type { AppPermission, SiteAccessLevel } from "@/lib/authz/types";

const viewer = (
  role: Viewer["role"],
  permissions: AppPermission[],
  grants: Array<[string, SiteAccessLevel]> = [],
): Viewer => ({
  id: "u1", email: "u@example.com", role,
  permissions: new Set(permissions),
  grants: new Map(grants),
});

describe("can", () => {
  it("allows a permission the viewer holds", () => {
    expect(can(viewer("developer", ["seo.run"]), "seo.run")).toBe(true);
  });
  it("refuses one they do not", () => {
    expect(can(viewer("developer", ["seo.run"]), "users.manage")).toBe(false);
  });
  it("refuses everything for a viewer with no permissions", () => {
    expect(can(viewer("client", []), "reports.generate")).toBe(false);
  });
});

describe("canAccessSite", () => {
  it("lets a viewer with sites.view_all reach any site at any level", () => {
    const v = viewer("developer", ["sites.view_all"]);
    expect(canAccessSite(v, "any-site", "read")).toBe(true);
    expect(canAccessSite(v, "any-site", "manage")).toBe(true);
  });

  it("lets a client reach only a granted site", () => {
    const v = viewer("client", ["reports.generate"], [["s1", "read"]]);
    expect(canAccessSite(v, "s1", "read")).toBe(true);
    expect(canAccessSite(v, "s2", "read")).toBe(false);
  });

  it("refuses a read grant where manage is required", () => {
    // This is what stops a client triggering an inventory refresh, which
    // opens an MCP connection and runs PHP on the customer's site.
    const v = viewer("client", ["reports.generate"], [["s1", "read"]]);
    expect(canAccessSite(v, "s1", "manage")).toBe(false);
  });

  it("accepts a manage grant where only read is required", () => {
    const v = viewer("client", [], [["s1", "manage"]]);
    expect(canAccessSite(v, "s1", "read")).toBe(true);
  });
});

describe("visibleSiteIds", () => {
  it("returns \"all\" for a viewer with sites.view_all", () => {
    expect(visibleSiteIds(viewer("admin", ["sites.view_all"]), ["a", "b"])).toBe("all");
  });
  it("returns only granted ids otherwise", () => {
    const v = viewer("client", [], [["b", "read"]]);
    expect(visibleSiteIds(v, ["a", "b", "c"])).toEqual(["b"]);
  });
  it("returns an empty list for a client with no grants", () => {
    expect(visibleSiteIds(viewer("client", []), ["a", "b"])).toEqual([]);
  });
});
