import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Phase 9a's whole point is that a client's reads go through `readDbFor`,
// which routes them through the user-scoped Supabase client so RLS (not
// application code) decides what comes back. `createServiceSupabase()`
// bypasses RLS entirely — dropping it into a dashboard page silently turns
// every access check on that page back into decoration, and nothing else in
// the test suite would catch it (each page's own gate would still look
// correct; only the actual rows returned would be wrong). This is a
// source-scan, not a runtime test, precisely because that regression doesn't
// show up in a unit test of the gate — it shows up in what the query returns
// against a real, RLS-enabled database.
const DASHBOARD_DIR = join(__dirname, "..", "src", "app", "(dashboard)");

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

const pageFiles = findPageFiles(DASHBOARD_DIR);

describe("dashboard page reads stay on the RLS-governed path", () => {
  it("found at least one page.tsx to check (guards against a rotted glob)", () => {
    expect(pageFiles.length).toBeGreaterThan(0);
  });

  it.each(pageFiles)("%s does not import createServiceSupabase", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/createServiceSupabase/);
  });
});

describe("the site overview page never unconditionally renders credentials-adjacent fields", () => {
  // Spec §5: mcp_endpoint and wp_username are credentials-adjacent and must
  // be omitted outright for a client, not merely blanked. Pinning this here
  // means a future edit that moves the row out of the `isClient` guard (or
  // adds a second, unguarded place that prints either value) fails a test
  // instead of shipping.
  const source = readFileSync(
    join(DASHBOARD_DIR, "sites", "[id]", "page.tsx"),
    "utf8",
  );

  it("does not render mcp_endpoint unconditionally", () => {
    // The only occurrence of `site.mcp_endpoint` must sit inside the
    // `isClient ? [] : [...]` row-building expression that omits it for
    // clients — never used bare (e.g. as a fallback rendered regardless of
    // role).
    const occurrences = source.split("site.mcp_endpoint").length - 1;
    expect(occurrences).toBe(1);
    expect(source).toContain('isClient ? [] : [{ term: "MCP endpoint", value: site.mcp_endpoint');
  });

  it("does not render wp_username unconditionally", () => {
    const occurrences = source.split("site.wp_username").length - 1;
    // One occurrence inside the client-omitted Connection-card row, one
    // inside the `!isClient` guarded "Copy WP username" control. Both are
    // role-gated; there must be no third, unguarded occurrence.
    expect(occurrences).toBe(2);
    expect(source).toContain('isClient ? [] : [{ term: "WP user", value: site.wp_username');
    expect(source).toContain("!isClient && (");
  });
});
