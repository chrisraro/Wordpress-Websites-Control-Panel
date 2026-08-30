import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function token(name: string): string {
  // A normal string, not a template literal: `\s` inside a template literal
  // collapses to a bare "s" and the pattern silently stops matching.
  const m = CSS.match(new RegExp("--color-" + name + ":\\s*(#[0-9a-fA-F]{6})"));
  if (!m) throw new Error(`token --color-${name} not found in globals.css`);
  return m[1];
}

describe("foreground tokens meet WCAG AA on every surface they can land on", () => {
  // Computed from globals.css rather than hard-coded, so changing a token
  // re-runs the check instead of silently invalidating it. Ember previously
  // sat at 4.38:1 on the canvas and carried a usage rule ("keep it off the
  // page background") in place of a fix — a constraint every future author
  // had to remember. Error text is the last thing that should be hard to read.
  const surfaces = { canvas: "canvas", paper: "paper", "surface-alt": "surface-alt" };

  it.each(["ink", "ink-soft", "mid-gray", "ember", "status-good", "status-warn", "status-bad"])(
    "%s clears 4.5:1 on canvas, paper and surface-alt",
    (fg) => {
      for (const surface of Object.values(surfaces)) {
        const ratio = contrast(token(fg), token(surface));
        expect(ratio, `${fg} on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("keeps ember visibly red rather than darkening it into brown", () => {
    const hex = token("ember");
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    expect(r).toBeGreaterThan(0xc0);
    expect(g).toBeLessThan(0x30);
  });
});

describe("remote images are deferred", () => {
  // wordpress.org screenshots and icons: a theme search renders 24 of them,
  // most below the fold. Without lazy loading every one is fetched on load.
  it.each([
    ["marketplace plugins", join("src", "app", "(dashboard)", "marketplace", "page.tsx")],
    ["marketplace themes", join("src", "app", "(dashboard)", "marketplace", "themes", "page.tsx")],
    ["site theme install", join("src", "app", "(dashboard)", "sites", "[id]", "themes", "install-panel.tsx")],
  ])("%s defers its remote <img>", (_label, file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const imgs = source.match(/<img[\s\S]*?\/>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img, `an <img> in ${file} is missing loading="lazy"`).toContain('loading="lazy"');
      // Intrinsic size reserves the box so the row does not jump when the
      // image lands.
      expect(img, `an <img> in ${file} has no width/height`).toMatch(/width=\{/);
    }
  });
});
