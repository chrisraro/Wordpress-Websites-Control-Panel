import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// src/services/users/repo.ts documents setRole, deleteUser and
// setRolePermission as unguarded primitives: they write with no lockout
// logic at all, and every caller outside that module must go through the
// matching guard-enforcing wrapper in src/services/users/service.ts
// (changeUserRole, deleteManagedUser, setRolePermissionChecked), which
// re-reads the user list and applies the last-admin / self-delete / admin
// keeps users.manage rules immediately before writing. Calling a repo
// primitive directly from the action module would compile and even pass a
// casual test, but it silently skips those guards — a lockout with no
// recovery path except SQL against production. This is a source-scan, not a
// runtime test, precisely because a unit test of one call site looks
// identical whether it went through the guard or around it; only reading
// the actual call expression tells them apart.
//
// The scan matches on the *method name* being invoked — `.setRole(`,
// `.deleteUser(`, `.setRolePermission(` — on any receiver, not on the literal
// text `repo.setRole(`. `actions.ts` binds `const users = repo();`, so a
// naive string match on `repo.setRole(` would pass right through
// `users.setRole(...)`, which is exactly the unguarded call this test exists
// to catch. Matching the method name regardless of receiver closes that gap;
// it does allowlist any particular receiver name.
const ACTIONS_FILE = join(__dirname, "..", "src", "app", "(dashboard)", "users", "actions.ts");
const UNGUARDED_METHODS = ["setRole", "deleteUser", "setRolePermission"];

describe("users actions route guarded mutations through the service, not the repo", () => {
  const source = readFileSync(ACTIONS_FILE, "utf8");

  it("found the actions file to check (guards against a rotted path)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it.each(UNGUARDED_METHODS)("does not call the unguarded repo method %s(...) on any receiver", (method) => {
    const pattern = new RegExp(`\\.\\s*${method}\\s*\\(`);
    expect(source).not.toMatch(pattern);
  });
});
