import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The vitest environment here is "node" (see tests/wporg.test.ts and
// tests/connect-site-modal-close.test.ts for the same constraint), so this
// is a source-scan rather than a render test -- it pins the actual class
// string Modal computes for its children wrapper, the same way
// tests/pending-states.test.ts pins wiring rather than rendered output.
//
// Without a footer (the connect-site modal: its submit button lives inside
// `children`, not `footer`), the children wrapper had `pt-4` and no bottom
// padding, so content ran flush to the dialog's bottom edge -- the footer's
// own `p-5` normally supplies that space. ConfirmDialog always passes a
// footer, so it must not gain a second bottom padding on top of the
// footer's.
const MODAL_FILE = join(__dirname, "..", "src", "components", "ui", "modal.tsx");

describe("Modal: footerless bottom padding", () => {
  const source = readFileSync(MODAL_FILE, "utf8");

  it("found the file to check (guards against a rotted path)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("pads the bottom of the children wrapper only when there is no footer", () => {
    expect(source).toMatch(/px-5 pt-4 \$\{footer \? "" : "pb-5"\}/);
  });

  it("does not unconditionally add pb-5 to the children wrapper (would double-pad the footered case)", () => {
    expect(source).not.toMatch(/className="px-5 pt-4 pb-5"/);
  });

  it("ConfirmDialog still supplies a footer, so it is unaffected by this fix", () => {
    expect(source).toMatch(/footer=\{\s*<>/);
  });
});
