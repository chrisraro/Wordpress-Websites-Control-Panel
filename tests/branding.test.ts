import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The product was renamed from the placeholder "WP Control Panel" to "OCS
// Wordpress Control Panel" (feat/ocs-branding). A source-scan, not a
// component test, is the right tool here: the point isn't to render any one
// page, it's that the old string never creeps back in anywhere under src/ --
// a new page added later that copy-pastes the old header would pass every
// other test in the suite while still shipping the wrong name. See
// tests/authz-read-path.test.ts for the same pattern applied to a different
// invariant.
const SRC_DIR = join(__dirname, "..", "src");
const PRODUCT_NAME = "OCS Wordpress Control Panel";
const OLD_NAME = "WP Control Panel";

function findSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = findSourceFiles(SRC_DIR);

describe("branding: the old placeholder name is gone from src/", () => {
  it("found at least one source file to check (guards against a rotted glob)", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles)("%s does not contain the old product name", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toContain(OLD_NAME);
  });
});

describe("branding: the product name appears where a user actually sees it", () => {
  it("is the app's default document title, in layout metadata", () => {
    const source = readFileSync(join(SRC_DIR, "app", "layout.tsx"), "utf8");
    expect(source).toContain(`const PRODUCT_NAME = "${PRODUCT_NAME}";`);
    expect(source).toContain("default: PRODUCT_NAME");
  });

  it("is the heading on the login page", () => {
    const source = readFileSync(join(SRC_DIR, "app", "login", "page.tsx"), "utf8");
    expect(source).toContain(`<h1 className="text-heading-sm font-semibold text-ink">${PRODUCT_NAME}</h1>`);
  });

  it("is the wordmark in both the desktop sidebar and the mobile sheet", () => {
    const source = readFileSync(join(SRC_DIR, "components", "shell", "sidebar.tsx"), "utf8");
    const occurrences = source.split(`<span>${PRODUCT_NAME}</span>`).length - 1;
    expect(occurrences).toBe(2);
  });
});
