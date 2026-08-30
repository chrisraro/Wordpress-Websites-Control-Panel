import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Two gaps confirmed by the whole-branch pending-states audit: the
// marketplace search boxes (`<form action="/marketplace" method="get">`,
// the slowest round trip in the app since it calls out to wordpress.org)
// and sign-out both rendered a plain <button> with no pending state at all
// -- pressing them did nothing visible until the page changed underneath
// the user. This is a source-scan, not a render test, for the same reason
// tests/roles-matrix-dialog-wiring.test.ts is: the bug is in which
// component reads `useFormStatus` and what the form's `action` prop is, not
// in any pure function's return value -- only reading the actual wiring
// catches a regression where a future edit swaps SubmitButton back out for
// a bare <button>.
const SRC_DIR = join(__dirname, "..", "src");
const SUBMIT_BUTTON_FILE = join(SRC_DIR, "components", "ui", "submit-button.tsx");
const SIDEBAR_FILE = join(SRC_DIR, "components", "shell", "sidebar.tsx");
const MARKETPLACE_PAGE = join(SRC_DIR, "app", "(dashboard)", "marketplace", "page.tsx");
const MARKETPLACE_THEMES_PAGE = join(SRC_DIR, "app", "(dashboard)", "marketplace", "themes", "page.tsx");

describe("SubmitButton: the shared useFormStatus button", () => {
  const source = readFileSync(SUBMIT_BUTTON_FILE, "utf8");

  it("found the file to check (guards against a rotted path)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("is a Client Component", () => {
    expect(source).toMatch(/^"use client";/);
  });

  it("reads pending state from useFormStatus, not a prop", () => {
    expect(source).toContain('import { useFormStatus } from "react-dom"');
    expect(source).toMatch(/const\s*\{\s*pending\s*\}\s*=\s*useFormStatus\(\)/);
  });

  it("disables the button and marks it aria-busy while pending, so the pending state reaches assistive tech too", () => {
    expect(source).toMatch(/disabled=\{pending\}/);
    expect(source).toMatch(/aria-busy=\{pending\}/);
  });

  it("swaps the label, not only the icon, while pending — matching ManageForm's vocabulary", () => {
    expect(source).toMatch(/pending \? busyLabel : label/);
    expect(source).toContain('pendingLabel ?? "Working…"');
  });
});

describe("Marketplace search stays a GET form, with its own pending state", () => {
  // This was briefly converted to a POST Server Action so that useFormStatus
  // could report pending. That trade was wrong: a search box is idempotent and
  // belongs on GET, where the query stays in a shareable, bookmarkable URL, the
  // back button returns to the previous search, and it works before hydration.
  // SearchSubmit gets the same pending affordance without changing the request.
  it.each([
    ["plugins", MARKETPLACE_PAGE, "/marketplace"],
    ["themes", MARKETPLACE_THEMES_PAGE, "/marketplace/themes"],
  ])("%s: submits as GET to %s", (_label, file, action) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain(`<form action="${action}" method="get"`);
  });

  it.each([
    ["plugins", MARKETPLACE_PAGE],
    ["themes", MARKETPLACE_THEMES_PAGE],
  ])("%s: never routes the search through a Server Action", (_label, file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/<form action=\{/);
    expect(source).not.toMatch(/searchPluginsAction|searchThemesAction/);
  });

  it.each([
    ["plugins", MARKETPLACE_PAGE],
    ["themes", MARKETPLACE_THEMES_PAGE],
  ])("%s: the Search button reports pending", (_label, file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/<SearchSubmit label="Search" pendingLabel="Searching…" \/>/);
    expect(source).not.toMatch(/<button[^>]*>\s*Search\s*<\/button>/);
  });

  it("SearchSubmit disables and announces itself while in flight", () => {
    const source = readFileSync(join(SRC_DIR, "components", "ui", "search-submit.tsx"), "utf8");
    expect(source).toContain('form.addEventListener("submit"');
    expect(source).toContain("disabled={pending}");
    expect(source).toContain("aria-busy={pending}");
    // Restored from the bfcache the old DOM comes back as it was left, which
    // would otherwise show a search frozen mid-flight.
    expect(source).toContain('window.addEventListener("pageshow"');
  });
});
describe("Sign out: the sidebar's form submits through SubmitButton, not a bare <button>", () => {
  const source = readFileSync(SIDEBAR_FILE, "utf8");

  it("found the file to check (guards against a rotted path)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("imports SubmitButton", () => {
    expect(source).toContain('import { SubmitButton } from "@/components/ui/submit-button"');
  });

  it("the logout form renders SubmitButton as a child, so useFormStatus has a form to read", () => {
    const formMatch = source.match(/<form action=\{logout\}[^>]*>[\s\S]*?<\/form>/);
    expect(formMatch).not.toBeNull();
    const formBody = formMatch![0];
    expect(formBody).toMatch(/<SubmitButton\b/);
    expect(formBody).not.toMatch(/<button\b/);
    expect(formBody).toContain('label="Sign out"');
    expect(formBody).toContain('pendingLabel="Signing out…"');
  });
});
