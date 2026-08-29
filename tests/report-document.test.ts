import { describe, it, expect } from "vitest";
import { geoGridKeywordLine } from "@/services/reports/document";

// Review finding #1: the PDF is the one artifact that leaves the building,
// shared with clients by token. It must not print the redefined `coverage()`
// percentage without disclosing when it was computed over a fraction of the
// grid, and it must not conflate "measured nothing" with "measured
// everything, ranked nowhere" — coverage() returns 0 for both.
describe("geoGridKeywordLine", () => {
  const base = { keyword: "coffee shop", runAt: "2026-01-15T00:00:00Z" };

  it("prints a plain line when every point was measured", () => {
    const line = geoGridKeywordLine({ ...base, averageRank: 4, coverage: 67, measured: 9, total: 9 });
    expect(line).toContain("coffee shop — average rank 4");
    expect(line).toContain("visible at 67% of locations");
    expect(line).not.toContain("only");
    expect(line).not.toContain("not enough data");
  });

  it("discloses the gap when only some points were measured", () => {
    // The motivating case: 80 of 81 lookups failed, the one survivor ranked
    // #3. coverage() alone reports 100% — the line must not print that
    // without also saying only 1 of 81 points fed it.
    const line = geoGridKeywordLine({ ...base, averageRank: 3, coverage: 100, measured: 1, total: 81 });
    expect(line).toContain("average rank 3");
    expect(line).toContain("visible at 100% of locations");
    expect(line).toContain("only 1 of 81 could be measured");
  });

  it("prints \"not enough data\" instead of a percentage when nothing was measured", () => {
    const line = geoGridKeywordLine({ ...base, averageRank: null, coverage: 0, measured: 0, total: 81 });
    expect(line).toContain("not enough data");
    expect(line).toContain("0 of 81 locations could be measured");
    expect(line).not.toMatch(/\d+% of locations/);
  });
});
