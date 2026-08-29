import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Finding 3 of the final whole-branch review.
//
// tests/authz-read-path.test.ts deliberately exempts every page under
// src/app/(dashboard)/users/** from its "no createServiceSupabase in a
// page" scan -- correctly, since these pages need the auth-admin API
// (last_sign_in_at, invite state) that only exists on the service-role
// client. Every other dashboard page's data is backstopped by an RLS
// policy even if its own application-level check were ever removed by
// mistake; this directory has no such backstop; the service-role client
// bypasses RLS entirely, and role_permissions (which the matrix page reads)
// has no RLS policy that would meaningfully restrict it either. That makes
// `requirePermission("users.manage")` the *only* thing standing between any
// signed-in account -- including a `client`, an external customer of the
// agency -- and the entire account directory, every account's role and
// site grants, and the editable permission matrix itself. No other page in
// this app carries that much weight on one line, which is exactly why this
// directory is the one place that needs a pin for it: removing the call
// here is a silent, total exposure of the user directory with nothing else
// to catch it, whereas removing an equivalent check elsewhere in the app
// still leaves RLS as a second line of defense.
const USERS_DIR = join(__dirname, "..", "src", "app", "(dashboard)", "users");

const GUARDED_PAGES = [
  join(USERS_DIR, "page.tsx"),
  join(USERS_DIR, "[id]", "page.tsx"),
  join(USERS_DIR, "roles", "page.tsx"),
];

describe("every /users page gates on requirePermission(\"users.manage\")", () => {
  it.each(GUARDED_PAGES)("%s calls requirePermission(\"users.manage\")", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source.length).toBeGreaterThan(0);
    expect(source).toContain('requirePermission("users.manage")');
  });
});
