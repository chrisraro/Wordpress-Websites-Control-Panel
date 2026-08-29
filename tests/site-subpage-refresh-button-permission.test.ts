import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Final whole-branch review, finding 7: sites/[id]/plugins/page.tsx and
// sites/[id]/themes/page.tsx computed `canRefresh` from the site grant
// alone and rendered the Refresh button on it -- the exact
// button-renders-then-action-refuses bug already fixed on
// sites/[id]/page.tsx (see 1dea50f). refreshInventoryAction
// (manage-actions.ts) checks both wp_toolkit.manage and a "manage" site
// grant, so a viewer with only the site grant (the level a client's own
// dashboard offers) would see an enabled button that then refuses. This is
// a source-scan, not a runtime render test, for the same reason
// authz-read-path.test.ts is: the regression is in which checks compose
// `canRefresh`, not in what a mocked call returns.
const SITE_DIR = join(__dirname, "..", "src", "app", "(dashboard)", "sites", "[id]");

const PAGES_WITH_REFRESH = [
  join(SITE_DIR, "page.tsx"),
  join(SITE_DIR, "plugins", "page.tsx"),
  join(SITE_DIR, "themes", "page.tsx"),
];

describe("canRefresh mirrors refreshInventoryAction's two checks on every page that renders the Refresh button", () => {
  for (const file of PAGES_WITH_REFRESH) {
    it(`checks both wp_toolkit.manage and a "manage" site grant in ${file.split(join("(dashboard)"))[1]}`, () => {
      const src = readFileSync(file, "utf8");
      const m = src.match(/const canRefresh = ([^;]+);/);
      expect(m).not.toBeNull();
      const rhs = m![1];
      expect(rhs).toMatch(/can\(viewer, "wp_toolkit\.manage"\)/);
      expect(rhs).toMatch(/canAccessSite\(viewer, id, "manage"\)/);
    });
  }
});
