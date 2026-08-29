import { describe, expect, it } from "vitest";
import {
  CLIENT_CROSS_TENANT_PERMISSIONS,
  CLIENT_GRANT_WARNINGS,
  requiresClientGrantConfirmation,
} from "@/app/(dashboard)/users/roles/client-grant-warnings";
import { APP_PERMISSIONS, APP_ROLES, type AppPermission, type AppRole } from "@/lib/authz/types";

// The exact four cells named in the branch review: the ones where `client`
// -- an external customer, not staff -- would gain reach into every OTHER
// customer's sites or accounts. This list is the source of truth the tests
// below check the implementation against; it is deliberately written out
// again here (rather than re-imported and trusted) so a change to
// CLIENT_CROSS_TENANT_PERMISSIONS that silently drops one of these fails a
// test instead of going unnoticed.
const EXPECTED_CROSS_TENANT_PERMISSIONS: readonly AppPermission[] = [
  "sites.view_all",
  "sites.manage",
  "wp_toolkit.manage",
  "users.manage",
];

describe("CLIENT_CROSS_TENANT_PERMISSIONS", () => {
  it("is exactly the four permissions named in the branch review, in any order", () => {
    expect(new Set(CLIENT_CROSS_TENANT_PERMISSIONS)).toEqual(new Set(EXPECTED_CROSS_TENANT_PERMISSIONS));
    expect(CLIENT_CROSS_TENANT_PERMISSIONS).toHaveLength(EXPECTED_CROSS_TENANT_PERMISSIONS.length);
  });

  it("only lists permissions that actually exist in APP_PERMISSIONS", () => {
    for (const permission of CLIENT_CROSS_TENANT_PERMISSIONS) {
      expect(APP_PERMISSIONS).toContain(permission);
    }
  });
});

describe("requiresClientGrantConfirmation", () => {
  it("requires confirmation for each cross-tenant permission when granting to client", () => {
    for (const permission of CLIENT_CROSS_TENANT_PERMISSIONS) {
      expect(requiresClientGrantConfirmation("client", permission, true)).toBe(true);
    }
  });

  it("never requires confirmation when revoking, even for a cross-tenant permission", () => {
    for (const permission of CLIENT_CROSS_TENANT_PERMISSIONS) {
      expect(requiresClientGrantConfirmation("client", permission, false)).toBe(false);
    }
  });

  it("never requires confirmation for roles other than client", () => {
    const staffRoles: AppRole[] = APP_ROLES.filter((role) => role !== "client");
    for (const role of staffRoles) {
      for (const permission of CLIENT_CROSS_TENANT_PERMISSIONS) {
        expect(requiresClientGrantConfirmation(role, permission, true)).toBe(false);
      }
    }
  });

  it("never requires confirmation for a permission outside the cross-tenant list, even granted to client", () => {
    const nonCrossTenant = APP_PERMISSIONS.filter(
      (permission) => !CLIENT_CROSS_TENANT_PERMISSIONS.includes(permission),
    );
    expect(nonCrossTenant.length).toBeGreaterThan(0);
    for (const permission of nonCrossTenant) {
      expect(requiresClientGrantConfirmation("client", permission, true)).toBe(false);
    }
  });

  it("covers every permission for every role without throwing (exhaustive sweep)", () => {
    for (const role of APP_ROLES) {
      for (const permission of APP_PERMISSIONS) {
        for (const granting of [true, false]) {
          expect(() => requiresClientGrantConfirmation(role, permission, granting)).not.toThrow();
        }
      }
    }
  });
});

describe("CLIENT_GRANT_WARNINGS", () => {
  it("has an entry for every cross-tenant permission, and only those", () => {
    expect(new Set(Object.keys(CLIENT_GRANT_WARNINGS))).toEqual(new Set(CLIENT_CROSS_TENANT_PERMISSIONS));
  });

  it("gives every entry a non-generic title and description", () => {
    for (const permission of CLIENT_CROSS_TENANT_PERMISSIONS) {
      const warning = CLIENT_GRANT_WARNINGS[permission];
      expect(warning).toBeDefined();
      expect(warning?.title.length ?? 0).toBeGreaterThan(10);
      expect(warning?.description.length ?? 0).toBeGreaterThan(40);
      // Not the generic wording this module falls back to if a warning were
      // ever missing -- each of the four must be real, specific copy.
      expect(warning?.description).not.toMatch(/reaches\s+beyond a single customer's own sites\.$/i);
    }
  });

  it("spells out the reach into every site and every WordPress administrator identity for sites.view_all", () => {
    // This is the one whose blast radius is least obvious from the
    // permission's own name (see decide.ts's canAccessSite short-circuit),
    // so the branch review calls out that it needs its own wording.
    const warning = CLIENT_GRANT_WARNINGS["sites.view_all"];
    expect(warning?.description).toMatch(/every.*site/i);
    expect(warning?.description).toMatch(/administrator/i);
    expect(warning?.description).toMatch(/email/i);
  });

  it("names the external-customer distinction for every entry", () => {
    for (const permission of CLIENT_CROSS_TENANT_PERMISSIONS) {
      expect(CLIENT_GRANT_WARNINGS[permission]?.description).toMatch(/customer/i);
    }
  });
});
