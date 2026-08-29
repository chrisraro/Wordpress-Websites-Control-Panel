import { describe, expect, it } from "vitest";
import {
  CLIENT_CROSS_TENANT_PERMISSIONS,
  CLIENT_GRANT_WARNINGS,
  requiresClientGrantConfirmation,
} from "@/app/(dashboard)/users/roles/client-grant-warnings";
import { APP_PERMISSIONS, APP_ROLES, type AppPermission, type AppRole } from "@/lib/authz/types";

// The exact five cells named in the branch review (four from the original
// review, plus queue.process from the final whole-branch review's finding
// 5): the ones where `client` -- an external customer, not staff -- would
// gain reach into every OTHER customer's sites, accounts, or queued work.
// This list is the source of truth the tests below check the
// implementation against; it is deliberately written out again here
// (rather than re-imported and trusted) so a change to
// CLIENT_CROSS_TENANT_PERMISSIONS that silently drops one of these fails a
// test instead of going unnoticed.
const EXPECTED_CROSS_TENANT_PERMISSIONS: readonly AppPermission[] = [
  "sites.view_all",
  "sites.manage",
  "wp_toolkit.manage",
  "users.manage",
  "queue.process",
];

describe("CLIENT_CROSS_TENANT_PERMISSIONS", () => {
  it("is exactly the five permissions named in the branch review, in any order", () => {
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

});

describe("CLIENT_GRANT_WARNINGS", () => {
  it("has an entry for every cross-tenant permission, and only those", () => {
    expect(new Set(Object.keys(CLIENT_GRANT_WARNINGS))).toEqual(new Set(CLIENT_CROSS_TENANT_PERMISSIONS));
  });

  it("gives every entry a defined, non-generic title and description", () => {
    for (const permission of CLIENT_CROSS_TENANT_PERMISSIONS) {
      const warning = CLIENT_GRANT_WARNINGS[permission];
      expect(warning).toBeDefined();
      expect(warning?.title).toBeTruthy();
      expect(warning?.description).toBeTruthy();
      // Not the generic wording this module falls back to if a warning were
      // ever missing -- each of the five must be real, specific copy.
      expect(warning?.description).not.toMatch(/reaches\s+beyond a single customer's own sites\.$/i);
    }
  });

  it("names the missing global scoping for queue.process, the one action gated on no site check at all", () => {
    // Finding 5 of the final whole-branch review: processQueueNowAction
    // gates on queue.process and nothing else -- no per-site check -- so
    // granting it to Client drains every OTHER customer's queued work.
    const warning = CLIENT_GRANT_WARNINGS["queue.process"];
    expect(warning?.description).toMatch(/queue/i);
    expect(warning?.description).toMatch(/snapshot_refresh|security_scan/);
  });

  it("does not overstate wp_toolkit.manage's reach: manageAction/refreshInventoryAction still check the specific site", () => {
    // Finding 6 of the final whole-branch review: this cell's real danger is
    // a leftover manage-level grant (finding 4), not unscoped reach into
    // every other customer's site -- checkSiteAccess(siteId, "manage")
    // already stops that.
    const warning = CLIENT_GRANT_WARNINGS["wp_toolkit.manage"];
    expect(warning?.description).not.toMatch(/every other customer's site, not only sites granted to them/i);
    expect(warning?.description).toMatch(/manage-level grant/i);
  });

  it("does not overstate sites.manage's reach: editing or disabling an existing site still requires a grant on it", () => {
    // Finding 6 of the final whole-branch review: only creating a brand new
    // site (sites/new/actions.ts) is unscoped -- testing/editing an existing
    // one goes through checkSiteAccess(siteId).
    const warning = CLIENT_GRANT_WARNINGS["sites.manage"];
    expect(warning?.description).not.toMatch(/connect, edit, or disable any other customer's site/i);
    expect(warning?.description).toMatch(/connect/i);
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
