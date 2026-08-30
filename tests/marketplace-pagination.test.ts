import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-scan in the same style as tests/pending-states.test.ts: the bug
// here is in which searchParams a page reads and how its search form is
// wired, not in any pure function's return value.
const SRC_DIR = join(__dirname, "..", "src");
const MARKETPLACE_PAGE = join(SRC_DIR, "app", "(dashboard)", "marketplace", "page.tsx");
const MARKETPLACE_THEMES_PAGE = join(SRC_DIR, "app", "(dashboard)", "marketplace", "themes", "page.tsx");
const PAGER_FILE = join(SRC_DIR, "app", "(dashboard)", "marketplace", "pager.tsx");

describe("Marketplace pages read ?page= and render a pager", () => {
  it.each([
    ["plugins", MARKETPLACE_PAGE],
    ["themes", MARKETPLACE_THEMES_PAGE],
  ])("%s: searchParams includes page, parsed through parsePage", (_label, file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/searchParams:\s*Promise<\{\s*q\?:\s*string;\s*page\?:\s*string\s*\}>/);
    expect(source).toContain('import { parsePage, clampToLastPage } from "@/lib/pagination"');
    expect(source).toContain("parsePage(pageParam)");
  });

  it.each([
    ["plugins", MARKETPLACE_PAGE],
    ["themes", MARKETPLACE_THEMES_PAGE],
  ])("%s: renders the shared Pager, passing the current query and page", (_label, file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/<Pager\s+basePath="[^"]+"\s+q=\{q\}\s+page=\{page\}\s+totalPages=\{results\.pages\}/);
  });

  // A new search term must land on page 1, not wherever the previous query
  // happened to be paged to. The search forms stay plain GET forms with no
  // hidden `page` field (tests/pending-states.test.ts pins the GET-form
  // requirement itself) -- submitting one therefore always navigates to a
  // URL with no `page` param, and parsePage(undefined) is 1. A hidden page
  // field re-appearing here would silently reintroduce the classic bug.
  it.each([
    ["plugins", MARKETPLACE_PAGE],
    ["themes", MARKETPLACE_THEMES_PAGE],
  ])("%s: the search form carries no hidden page field, so a new query starts at page 1", (_label, file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/name="page"/);
  });
});

describe("Pager", () => {
  const source = readFileSync(PAGER_FILE, "utf8");

  it("found the file to check (guards against a rotted path)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("is a Server Component (no client directive) -- the pager needs no client JS", () => {
    expect(source).not.toMatch(/^"use client";/);
  });

  it("renders links, not buttons, so prev/next work with middle-click and are crawlable", () => {
    expect(source).toContain("import Link from \"next/link\"");
    expect(source).not.toMatch(/<button/);
  });

  it("shows the reader's position, not just prev/next", () => {
    expect(source).toMatch(/Page \{page\} of \{totalPages\}/);
  });

  it("omits prev on page 1 and next on the last page rather than rendering a dead control", () => {
    expect(source).toMatch(/\{page > 1 \?/);
    expect(source).toMatch(/\{page < totalPages \?/);
  });

  it("renders nothing at all for a single-page result set", () => {
    expect(source).toMatch(/if \(totalPages <= 1\) return null;/);
  });
});
