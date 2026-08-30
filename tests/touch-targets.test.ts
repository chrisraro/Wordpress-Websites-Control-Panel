import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STYLES = readFileSync(join(process.cwd(), "src", "components", "ui", "styles.ts"), "utf8");
const MODAL = readFileSync(join(process.cwd(), "src", "components", "ui", "modal.tsx"), "utf8");
const SIDEBAR = readFileSync(join(process.cwd(), "src", "components", "shell", "sidebar.tsx"), "utf8");

/**
 * DESIGN.md sets a compact density and 36/40px reads correctly under a mouse,
 * but PRODUCT.md records phone use as a hard constraint and 36px is below
 * every touch guideline. `pointer-coarse` keys on the input device rather
 * than the viewport, so a touchscreen laptop gets the larger target and a
 * narrow desktop window does not — which is why these assert the variant
 * rather than a breakpoint.
 *
 * 11 on Tailwind's default scale is 11 x 0.25rem = 44px. This project
 * deliberately does not override the `--spacing` namespace (see globals.css),
 * so that arithmetic holds.
 *
 * Measured in a touch-emulated browser after this landed: 0 of 23 controls
 * under 44px with the mobile sheet open, modal close 26x26 -> 44x44, sheet
 * close 34x34 -> 44x44, hamburger 36x36 -> 44x44. Desktop unchanged at 40px.
 */
describe("touch targets reach 44px on coarse pointers", () => {
  it("both button sizes grow, and neither loses its compact desktop height", () => {
    expect(STYLES).toMatch(/sm:\s*"min-h-9[^"]*pointer-coarse:min-h-11"/);
    expect(STYLES).toMatch(/md:\s*"min-h-10[^"]*pointer-coarse:min-h-11"/);
  });

  it("text inputs grow too", () => {
    expect(STYLES).toMatch(/min-h-10 pointer-coarse:min-h-11/);
  });

  it("icon-only controls pin both dimensions, not just height", () => {
    // A label widens a text button; an icon has none, so height alone leaves
    // a small square.
    expect(STYLES).toMatch(/size-8 pointer-coarse:size-11/);
  });

  it.each([
    ["modal close", () => MODAL, /iconButtonClass\(/],
    ["sidebar close and hamburger", () => SIDEBAR, /iconButtonClass\(/],
  ])("%s uses the shared icon control", (_label, read, pattern) => {
    expect(read()).toMatch(pattern);
  });

  it("no icon-only control keeps a bare p-1 or p-2 box", () => {
    // The modal close was `-m-1 rounded-2xl p-1` around an 18px glyph: 26x26,
    // and the primary way to dismiss a bottom sheet on a phone.
    for (const [name, src] of [["modal", MODAL], ["sidebar", SIDEBAR]] as const) {
      const bare = src.match(/className="[^"]*\brounded-2xl p-[12]\b[^"]*"/g) ?? [];
      expect(bare, `${name} still has a bare icon-button box: ${bare.join(", ")}`).toHaveLength(0);
    }
  });

  it("sidebar nav rows and the wordmark grow on touch", () => {
    // The nav row's className wraps across lines, so allow generous slack
    // between the two tokens rather than assuming they sit adjacent.
    expect(SIDEBAR).toMatch(/min-h-10[\s\S]{0,200}pointer-coarse:min-h-11/);
    const wordmarks = SIDEBAR.match(/min-h-8[^"]*pointer-coarse:min-h-11/g) ?? [];
    expect(wordmarks.length, "both wordmark links should grow").toBe(2);
  });
});
