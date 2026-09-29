import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The vitest environment is "node", so these pin the boundary files' shape by
// source (see tests/modal-padding.test.ts for the same approach).
//
// Without any error.tsx / global-error.tsx, a thrown render error in any
// dashboard page fell through to Next's bare default screen: the sidebar
// vanished and there was no way to retry.
const APP = join(__dirname, "..", "src", "app");
const DASHBOARD_ERROR = join(APP, "(dashboard)", "error.tsx");
const GLOBAL_ERROR = join(APP, "global-error.tsx");

for (const [label, file] of [
  ["(dashboard)/error.tsx", DASHBOARD_ERROR],
  ["global-error.tsx", GLOBAL_ERROR],
] as const) {
  describe(label, () => {
    it("exists", () => {
      expect(existsSync(file)).toBe(true);
    });

    const source = existsSync(file) ? readFileSync(file, "utf8") : "";

    it("is a client component (error boundaries must be)", () => {
      expect(source.trimStart().startsWith('"use client"')).toBe(true);
    });

    it("default-exports a component taking error and reset", () => {
      expect(source).toMatch(/export default function \w+\(\{\s*error,\s*reset,?\s*\}/);
    });

    it("offers a retry wired to reset()", () => {
      expect(source).toMatch(/onClick=\{\(\) => reset\(\)\}/);
    });

    it("shows the digest when present", () => {
      expect(source).toMatch(/error\.digest && /);
    });

    it("renders error.message only in development", () => {
      expect(source).toContain('const showDetail = process.env.NODE_ENV === "development"');
      // Every place error.message is rendered must sit behind showDetail.
      const renders = source.match(/\{error\.message\}/g) ?? [];
      expect(renders.length).toBe(1);
      expect(source).toMatch(/showDetail && error\.message && \(/);
    });
  });
}

describe("global-error.tsx replaces the root layout", () => {
  const source = readFileSync(GLOBAL_ERROR, "utf8");

  it("renders its own <html> and <body>", () => {
    expect(source).toContain("<html");
    expect(source).toContain("<body");
  });

  it("loads the global stylesheet so the design tokens still apply", () => {
    expect(source).toContain('import "./globals.css"');
  });
});

describe("(dashboard)/error.tsx keeps the shell", () => {
  const source = readFileSync(DASHBOARD_ERROR, "utf8");

  it("does not render its own <html>/<body> (it sits inside the dashboard layout)", () => {
    expect(source).not.toContain("<html");
    expect(source).not.toContain("<body");
  });
});
