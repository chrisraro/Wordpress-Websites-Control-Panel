import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Audit 2026-09-29, open 9: matrix edits are admin-only (enforced in
// setRolePermissionChecked; see tests/users-service.test.ts). The page must
// not offer a non-admin `users.manage` holder a grid of checkboxes the server
// will refuse -- it shows the matrix read-only with the reason. Source scan,
// matching tests/roles-matrix-dialog-wiring.test.ts: the question is how the
// component is wired, which a render of a pure helper cannot answer.
const DIR = join(__dirname, "..", "src", "app", "(dashboard)", "users", "roles");
const matrix = readFileSync(join(DIR, "matrix.tsx"), "utf8");
const page = readFileSync(join(DIR, "page.tsx"), "utf8");

describe("permission matrix is read-only for non-admins", () => {
  it("the page decides editability from the viewer's role, read per request", () => {
    expect(page).toMatch(/const viewer = await requirePermission\("users\.manage"\)/);
    expect(page).toMatch(/canEdit=\{viewer\.role === "admin"\}/);
  });

  it("the matrix takes canEdit and refuses a toggle without it", () => {
    expect(matrix).toMatch(/canEdit: boolean/);
    const m = matrix.match(/function requestToggle\([\s\S]*?\n  \}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/if \(!canEdit\b.*\) return;/);
  });

  it("every checkbox is disabled without canEdit", () => {
    expect(matrix).toMatch(/const disabled = !canEdit \|\| locked \|\| pendingKeys\.has\(key\);/);
  });

  it("states the one-line reason a non-admin sees", () => {
    expect(matrix).toContain("Only an administrator can edit this matrix");
  });

  it("no longer tells operators that Manage users can edit the matrix", () => {
    expect(matrix).not.toMatch(/but they can edit this matrix/);
  });
});
