import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// sites/[id]/page.tsx rendered ReconnectCard (both the banner and the quiet
// Connection-card row) and OriginOverrideForm on can(viewer, "sites.manage")
// alone. Their actions -- reconnectSiteAction and setOriginAction in
// manage-actions.ts -- check sites.manage AND a "manage" grant on the site,
// so a viewer with the permission but only a read grant saw forms the
// action then refused. Source-scan for the same reason as
// tests/site-subpage-refresh-button-permission.test.ts: the regression is in
// which checks compose the gate.
const SITE_DIR = join(__dirname, "..", "src", "app", "(dashboard)", "sites", "[id]");
const PAGE = join(SITE_DIR, "page.tsx");
const ACTIONS = join(SITE_DIR, "manage-actions.ts");

describe("site page gates the connection forms on the same checks their actions make", () => {
  const src = readFileSync(PAGE, "utf8");

  it("canManageConnection requires sites.manage and a manage grant on this site", () => {
    const m = src.match(/const canManageConnection = ([^;]+);/);
    expect(m).not.toBeNull();
    const rhs = m![1];
    // canTestConnection is can(viewer, "sites.manage").
    expect(src).toMatch(/const canTestConnection = can\(viewer, "sites\.manage"\);/);
    expect(rhs).toMatch(/canTestConnection|can\(viewer, "sites\.manage"\)/);
    expect(rhs).toMatch(/canAccessSite\(viewer, id, "manage"\)/);
  });

  it("every ReconnectCard is gated on canManageConnection", () => {
    const gates = [...src.matchAll(/\{(\w+) && connection[^\n]*\n\s*<ReconnectCard/g)].map((m) => m[1]);
    expect(gates.length).toBe(2);
    expect(gates.every((g) => g === "canManageConnection")).toBe(true);
  });

  it("OriginOverrideForm is gated on canManageConnection", () => {
    expect(src).toMatch(/\{canManageConnection && connection && \(\s*<OriginOverrideForm/);
  });

  it("the actions really do require a manage grant (keeps this test honest)", () => {
    const actions = readFileSync(ACTIONS, "utf8");
    for (const fn of ["reconnectSiteAction", "setOriginAction"]) {
      const start = actions.indexOf(`export async function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const head = actions.slice(start, start + 700);
      expect(head).toContain('checkPermission("sites.manage")');
      expect(head).toContain('checkSiteAccess(siteId, "manage")');
    }
  });
});
