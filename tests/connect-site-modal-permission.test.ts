import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The intercepted /sites/new route (src/app/(dashboard)/@modal/(.)sites/new/page.tsx)
// is a real Next.js route with its own URL and its own entry point -- Next
// falls back to rendering the plain page.tsx under sites/new/ whenever this
// one isn't reached by a client-side navigation from within (dashboard), but
// a user can also land on it directly (a fresh tab, a reload while the modal
// is open, a shared link caught mid-navigation). It must not rely on the
// plain page's requirePermission call, or on the trigger being hidden from
// users who lack the permission -- it needs its own gate. This pins that the
// call stays in place the same way tests/users-pages-require-permission.test.ts
// pins it for every page under /users.
const INTERCEPTED_PAGE = join(
  __dirname,
  "..",
  "src",
  "app",
  "(dashboard)",
  "@modal",
  "(.)sites",
  "new",
  "page.tsx",
);

describe("the intercepted /sites/new modal route gates on requirePermission(\"sites.manage\")", () => {
  it("calls requirePermission(\"sites.manage\")", () => {
    const source = readFileSync(INTERCEPTED_PAGE, "utf8");
    expect(source.length).toBeGreaterThan(0);
    expect(source).toContain('requirePermission("sites.manage")');
  });
});
