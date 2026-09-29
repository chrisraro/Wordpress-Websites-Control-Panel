import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The vitest environment is "node" (see tests/modal-padding.test.ts), so this
// pins the route structure and wiring by source rather than by rendering.
//
// The @modal parallel slot only had default.tsx and the (.)sites/new
// interception. default.tsx covers first load and hard navigations; on a
// SOFT navigation Next keeps whatever an unmatched slot last rendered. So
// after createSite redirected to /sites/<id>, or close() called
// router.replace("/dashboard"), the slot kept the modal mounted -- and with
// its `open` state stuck at false, "Connect site" could not reopen it.
const MODAL_DIR = join(__dirname, "..", "src", "app", "(dashboard)", "@modal");
const CATCH_ALL = join(MODAL_DIR, "[...catchAll]", "page.tsx");
const MODAL_COMPONENT = join(MODAL_DIR, "(.)sites", "new", "connect-site-modal.tsx");

describe("@modal slot resets on soft navigation", () => {
  it("has a catch-all page so every non-intercepted URL explicitly matches the slot", () => {
    expect(existsSync(CATCH_ALL)).toBe(true);
  });

  it("the catch-all renders nothing", () => {
    const source = readFileSync(CATCH_ALL, "utf8");
    expect(source).toMatch(/export default function \w+\(\)\s*\{\s*return null;\s*\}/);
  });

  it("keeps default.tsx for first load / hard navigation", () => {
    expect(existsSync(join(MODAL_DIR, "default.tsx"))).toBe(true);
  });
});

describe("ConnectSiteModal derives open from the route", () => {
  const source = readFileSync(MODAL_COMPONENT, "utf8");

  it("found the file to check (guards against a rotted path)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("reads the pathname", () => {
    expect(source).toContain("usePathname()");
  });

  it("is open only on /sites/new and only until closed on this visit", () => {
    expect(source).toMatch(/const open = pathname === "\/sites\/new" && closedOn !== pathname/);
  });

  it("clears a previous close when the pathname changes, so reopening works", () => {
    expect(source).toMatch(/if \(closedOn !== null && closedOn !== pathname\)\s*\{\s*setClosedOn\(null\)/);
  });

  it("no longer holds a one-way useState(true) open flag", () => {
    expect(source).not.toMatch(/useState\(true\)/);
  });
});
