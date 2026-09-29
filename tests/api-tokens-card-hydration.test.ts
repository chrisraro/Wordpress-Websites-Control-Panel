import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isoFallback } from "@/components/ui/local-time";

// ApiTokensCard is a Client Component that is server-rendered and then
// hydrated (on /account and /users/[id]). It formatted dates with
// toLocaleDateString()/toLocaleString() and computed "Expired" from
// Date.now() during render, so the server's locale/time zone/clock and the
// browser's produced different text: a hydration mismatch. The node test
// environment cannot render, so the card is pinned by source and the
// deterministic first-render text is unit-tested directly.
const DASH = join(__dirname, "..", "src", "app", "(dashboard)");
const CARD = join(DASH, "users", "[id]", "api-tokens-card.tsx");
const CALL_SITES = [join(DASH, "users", "[id]", "page.tsx"), join(DASH, "account", "page.tsx")];

describe("isoFallback (the server/first-client render of LocalTime)", () => {
  it("renders a date as its UTC calendar day regardless of the input offset", () => {
    expect(isoFallback("2026-09-12T23:30:00+00:00", "date")).toBe("2026-09-12");
    expect(isoFallback("2026-09-13T01:30:00+02:00", "date")).toBe("2026-09-12");
  });

  it("renders a datetime as UTC to the minute, labelled", () => {
    expect(isoFallback("2026-09-12T10:05:59.123456+00:00", "datetime")).toBe("2026-09-12 10:05 UTC");
  });

  it("passes an unparseable value through unchanged instead of printing Invalid Date", () => {
    expect(isoFallback("not a date", "datetime")).toBe("not a date");
  });
});

describe("ApiTokensCard renders nothing environment-dependent", () => {
  const src = readFileSync(CARD, "utf8");

  it("found the file to check (guards against a rotted path)", () => {
    expect(src.length).toBeGreaterThan(0);
  });

  it("does not call toLocale* or Date.now() anywhere", () => {
    expect(src).not.toMatch(/toLocale(Date|Time)?String\(/);
    expect(src).not.toContain("Date.now()");
  });

  it("formats created/last-used through LocalTime", () => {
    expect(src).toContain('<LocalTime iso={t.created_at} mode="date" />');
    expect(src).toContain("<LocalTime iso={t.last_used_at} />");
  });

  it("computes status against the server-supplied renderedAt", () => {
    expect(src).toContain("tokenStatus(t, renderedAt)");
    expect(src).toMatch(/renderedAt: number;/);
  });

  for (const file of CALL_SITES) {
    it(`passes renderedAt from the server in ${file.split("(dashboard)")[1]}`, () => {
      const page = readFileSync(file, "utf8");
      expect(page).toMatch(/<ApiTokensCard[\s\S]*?renderedAt=\{Date\.now\(\)\}[\s\S]*?\/>/);
    });
  }
});
