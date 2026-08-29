import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Middleware refreshes the Supabase session and redirects anonymous visitors.
 * It performs NO authorization, and must never be given any.
 *
 * Next.js CVE-2025-29927 let a crafted `x-middleware-subrequest` header convince
 * the framework that middleware had already run, skipping it entirely. Every app
 * whose only gate lived there was fully exposed. Middleware is an optimisation
 * the framework can short-circuit, not a security boundary.
 *
 * This test exists so that lesson cannot be quietly undone by a well-meaning
 * refactor that "helpfully" centralises a permission check here.
 * See docs/superpowers/specs/2026-08-29-phase9a-authorization-design.md §4.2.
 */
const SRC = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");

describe("middleware performs no authorization", () => {
  it("does not import the authorization layer", () => {
    expect(SRC).not.toMatch(/from\s+["']@\/lib\/authz/);
  });

  it("calls none of the authorization helpers", () => {
    for (const helper of [
      "getViewer", "requireViewer", "requirePermission", "requireSiteAccess",
      "checkPermission", "checkSiteAccess", "can(", "canAccessSite",
    ]) {
      expect(SRC).not.toContain(helper);
    }
  });

  it("never reads a role, permission or grant table", () => {
    for (const table of [
      "user_roles", "role_permissions", "user_permission_overrides", "user_site_access",
    ]) {
      expect(SRC).not.toContain(table);
    }
  });

  it("records why, so the constraint survives a refactor", () => {
    expect(SRC).toMatch(/CVE-2025-29927/);
  });
});
