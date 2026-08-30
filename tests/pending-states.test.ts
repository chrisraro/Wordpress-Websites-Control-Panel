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
const SEARCH_ACTIONS_FILE = join(SRC_DIR, "app", "(dashboard)", "marketplace", "search-actions.ts");

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

describe("Marketplace search: both forms submit through a function action with a pending SubmitButton", () => {
  for (const [label, file, actionName] of [
    ["plugins", MARKETPLACE_PAGE, "searchPluginsAction"],
    ["themes", MARKETPLACE_THEMES_PAGE, "searchThemesAction"],
  ] as const) {
    it(`${label}: does not fall back to a plain GET <form action="...">`, () => {
      const source = readFileSync(file, "utf8");
      expect(source.length).toBeGreaterThan(0);
      expect(source).not.toMatch(/action="\/marketplace[^"]*"\s+method="get"/);
    });

    it(`${label}: the search form's action is the ${actionName} Server Action`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain(`import { ${actionName} } from`);
      expect(source).toMatch(new RegExp(`<form action=\\{${actionName}\\}`));
    });

    it(`${label}: the Search button is SubmitButton, not a bare <button>`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain('import { SubmitButton } from "@/components/ui/submit-button"');
      expect(source).toMatch(/<SubmitButton label="Search"/);
    });
  }
});

describe("Marketplace search actions: a Server Action, preserving the shareable ?q= URL", () => {
  const source = readFileSync(SEARCH_ACTIONS_FILE, "utf8");

  it("found the file to check (guards against a rotted path)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("is a Server Action module", () => {
    expect(source).toMatch(/^"use server";/);
  });

  it("redirects back to the same page with ?q= preserved, for both plugins and themes", () => {
    expect(source).toMatch(/redirect\(q \? `\/marketplace\?q=\$\{encodeURIComponent\(q\)\}` : "\/marketplace"\)/);
    expect(source).toMatch(
      /redirect\(q \? `\/marketplace\/themes\?q=\$\{encodeURIComponent\(q\)\}` : "\/marketplace\/themes"\)/,
    );
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
