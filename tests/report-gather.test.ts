import { describe, it, expect } from "vitest";
import { REPORT_SECTIONS, parseSections } from "@/services/reports/types";

describe("parseSections", () => {
  it("lists the four sections", () => {
    expect(REPORT_SECTIONS).toEqual(["security", "seo", "geogrid", "inventory"]);
  });
  it("keeps valid sections in canonical order and dedupes", () => {
    expect(parseSections(["seo", "security", "seo"])).toEqual(["security", "seo"]);
  });
  it("drops unknown values and tolerates garbage input", () => {
    expect(parseSections(["seo", "nonsense", 42, null])).toEqual(["seo"]);
    expect(parseSections("seo")).toEqual([]);
    expect(parseSections(null)).toEqual([]);
    expect(parseSections([])).toEqual([]);
  });
});
