import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
//
// Finding 7 of the final whole-branch review: an earlier version of this
// test hardcoded three literal page paths. That is exactly as narrow as
// authz-read-path.test.ts's directory-wide exemption is wide -- a future
// src/app/(dashboard)/users/audit/page.tsx would be exempt from the
// service-role scan there *and* invisible to this pin, reproducing the
// same hole one page later. Globbing the directory closes that: any new
// page.tsx anywhere under /users is picked up automatically.
const USERS_DIR = join(__dirname, "..", "src", "app", "(dashboard)", "users");

function findPageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findPageFiles(full));
    } else if (entry === "page.tsx") {
      out.push(full);
    }
  }
  return out;
}

const guardedPages = findPageFiles(USERS_DIR);

// The three pages known to exist as of this writing. Asserted as a subset,
// not the exact set, so a legitimate new page under /users does not require
// editing this list -- but an empty or broken glob (which would otherwise
// make the it.each below pass vacuously with zero cases) still fails loudly.
const KNOWN_PAGES = [
  join(USERS_DIR, "page.tsx"),
  join(USERS_DIR, "[id]", "page.tsx"),
  join(USERS_DIR, "roles", "page.tsx"),
];

describe("every /users page gates on requirePermission(\"users.manage\")", () => {
  it("found at least the three known /users pages (guards against a vacuous glob)", () => {
    for (const page of KNOWN_PAGES) {
      expect(guardedPages).toContain(page);
    }
  });

  it.each(guardedPages)("%s calls requirePermission(\"users.manage\")", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source.length).toBeGreaterThan(0);
    expect(source).toContain('requirePermission("users.manage")');
  });
});
