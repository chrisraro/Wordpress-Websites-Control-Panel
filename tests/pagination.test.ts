import { describe, it, expect } from "vitest";
import { parsePage, clampToLastPage, MAX_PAGE } from "@/lib/pagination";

// wordpress.org does not validate `request[page]` itself -- probed live,
// `-4` came back reinterpreted as page 4 (an abs(), not a rejection), and a
// non-numeric value quietly became page 1. Both of these functions exist so
// our own code never forwards a raw, unsanitised page number to an adapter,
// rather than trusting the upstream API's ad-hoc handling of bad input.
describe("parsePage", () => {
  it("defaults a missing page to 1", () => {
    expect(parsePage(undefined)).toBe(1);
  });

  it("ignores a non-numeric page and falls back to 1", () => {
    expect(parsePage("abc")).toBe(1);
  });

  it("rejects zero and negative pages, falling back to 1", () => {
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-4")).toBe(1);
    expect(parsePage("-1")).toBe(1);
  });

  it("truncates a fractional page rather than rounding", () => {
    expect(parsePage("2.9")).toBe(2);
  });

  it("passes a normal, valid page straight through", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage("1")).toBe(1);
  });

  it("caps an absurdly large page at MAX_PAGE instead of forwarding it verbatim", () => {
    expect(parsePage("99999")).toBe(MAX_PAGE);
    expect(parsePage("99999999999999999999")).toBe(MAX_PAGE);
  });

  it("takes the first value when the URL supplies the param more than once", () => {
    expect(parsePage(["2", "9"])).toBe(2);
  });
});

describe("clampToLastPage", () => {
  it("leaves an in-range page untouched", () => {
    expect(clampToLastPage(3, 10)).toBe(3);
  });

  it("clamps a page beyond the last page down to it", () => {
    expect(clampToLastPage(40, 12)).toBe(12);
  });

  it("never returns less than page 1, even against a zero or negative total", () => {
    expect(clampToLastPage(5, 0)).toBe(1);
    expect(clampToLastPage(1, 0)).toBe(1);
  });
});
