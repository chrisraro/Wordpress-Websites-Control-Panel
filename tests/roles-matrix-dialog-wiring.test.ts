import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Finding 10 of the final whole-branch review: every test in
// tests/roles-matrix-client-grant-confirmation.test.ts covers the pure
// client-grant-warnings helper module, but the bug this whole feature exists
// to fix lived in matrix.tsx's wiring -- specifically, whether the
// checkbox's click actually routes through the confirmation dialog before
// any write, rather than firing the optimistic write directly and only
// showing the dialog as decoration. This is a source-scan, not a runtime
// test, matching this repo's house style for exactly this situation (see
// tests/users-actions-guarded.test.ts and tests/authz-read-path.test.ts):
// a unit test of a pure function cannot tell the difference between a
// component that calls it and respects the result and one that calls it and
// ignores the result, only reading the actual wiring can.
const MATRIX_FILE = join(
  __dirname,
  "..",
  "src",
  "app",
  "(dashboard)",
  "users",
  "roles",
  "matrix.tsx",
);

describe("PermissionMatrix routes every checkbox click through requestToggle", () => {
  const source = readFileSync(MATRIX_FILE, "utf8");

  it("found the matrix file to check (guards against a rotted path)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("the checkbox's onChange calls requestToggle, not applyToggle directly", () => {
    expect(source).toMatch(/onChange=\{\(\)\s*=>\s*requestToggle\(role,\s*permission\)\}/);
    // If a click ever called applyToggle directly, it would perform the
    // optimistic write before requestToggle's confirmation check ever runs
    // -- exactly the bug this dialog exists to prevent.
    expect(source).not.toMatch(/onChange=\{\(\)\s*=>\s*applyToggle\(/);
  });

  it("requestToggle sets the confirm state and returns before ever calling applyToggle", () => {
    const m = source.match(/function requestToggle\([\s\S]*?\n  \}/);
    expect(m).not.toBeNull();
    const body = m![0];

    const confirmCellSetIndex = body.indexOf("setConfirmCell({ role, permission })");
    const returnIndex = body.indexOf("return;", confirmCellSetIndex);
    const applyToggleCallIndex = body.indexOf("applyToggle(role, permission)");

    expect(confirmCellSetIndex).toBeGreaterThan(-1);
    // The `return` guarding the confirmation branch must appear after
    // setConfirmCell and before the unconditional applyToggle call at the
    // bottom of the function -- otherwise the write would run regardless of
    // whether the dialog was shown.
    expect(returnIndex).toBeGreaterThan(confirmCellSetIndex);
    expect(applyToggleCallIndex).toBeGreaterThan(returnIndex);
  });
});
