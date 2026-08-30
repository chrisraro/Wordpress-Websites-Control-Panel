import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
const MAP = readFileSync(
  join(process.cwd(), "src", "app", "(dashboard)", "sites", "[id]", "geogrid", "grid-map.tsx"),
  "utf8",
);

/** Resolve a token to a hex value, following one level of var() aliasing. */
function resolve(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`circular token reference at ${name}`);
  seen.add(name);
  const m = CSS.match(new RegExp("--" + name + ":\s*([^;]+);"));
  if (!m) throw new Error(`token --${name} not found in globals.css`);
  const value = m[1].trim();
  const alias = value.match(/^var\(--([\w-]+)\)$/);
  return alias ? resolve(alias[1], seen) : value;
}

describe("the GeoGrid map draws from design tokens", () => {
  // Leaflet paints into its own DOM with inline styles, so it cannot use
  // Tailwind classes and needs literal colour strings. It used to carry its
  // own copies of all six ramp colours, and its mid-gray was still #737373
  // long after the token was darkened to #707070 for contrast — the map had
  // drifted from the rest of the app without anything failing.

  it("reads every colour through a CSS custom property", () => {
    // Comments are stripped first: this file's docblock quotes #737373 and
    // #707070 as prose while explaining the drift it exists to prevent, and
    // those are not colours the map paints with.
    //
    // Matches hex in ANY quoting, 3- or 6-digit, not just a double-quoted
    // 6-digit one. The previous version required `"#rrggbb"`, so `color:#fff`
    // and `border:2px solid #fff` inside the divIcon template literal sat
    // here unseen for as long as the test did -- the exact drift this is for.
    // Line filtering rather than a comment-stripping regex: the escapes that
    // pattern needs are exactly the ones that collapse when written inline,
    // and this file has already been broken that way twice.
    const code = MAP.split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    const allHex = code.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    const inTokenCall = code.match(/token\(\s*"[^"]+",\s*"#[0-9a-fA-F]{3,8}"\s*\)/g) ?? [];
    expect(allHex.length, `hex in code: ${allHex.join(", ")}`).toBeGreaterThan(0);
    // Every hex the map paints with must be a token() fallback.
    expect(allHex.length, `bare hex outside token(): ${allHex.join(", ")}`).toBe(
      inTokenCall.length,
    );
  });

  it.each([
    ["color-rank-1", "#15803d"],
    ["color-rank-2", "#4d7c0f"],
    ["color-rank-3", "#a16207"],
    ["color-rank-4", "#c2410c"],
    ["color-rank-5", "#b91c1c"],
    ["color-rank-unmeasured", "#707070"],
    ["color-mid-gray", "#707070"],
    ["color-ink", "#0a0a0a"],
  ])("%s's fallback in grid-map matches the token's real value", (name, expected) => {
    // The whole point of a fallback is to be reached when the stylesheet has
    // not applied. A fallback that has drifted from its token is the original
    // bug in slow motion, so pin them to each other.
    expect(resolve(name)).toBe(expected);
    // Normal string, not a template literal: `\(` and `\s` inside a template
    // literal collapse to bare "(" and "s" and the pattern stops matching.
    const call = MAP.match(new RegExp('token\\("--' + name + '",\\s*"([^"]+)"\\)'));
    expect(call, `grid-map.tsx never reads --${name}`).not.toBeNull();
    expect(call![1]).toBe(expected);
  });

  it("aliases the ramp to the status scale rather than copying it", () => {
    // rank-1/3/4/5 must stay var() references, so darkening a status colour
    // for contrast carries into the map automatically.
    for (const n of ["color-rank-1", "color-rank-3", "color-rank-4", "color-rank-5"]) {
      const raw = CSS.match(new RegExp("--" + n + ":\s*([^;]+);"))![1].trim();
      expect(raw, `--${n} should alias a status token, not hard-code a hex`).toMatch(/^var\(--color-status-/);
    }
  });
});
