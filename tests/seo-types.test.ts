import { describe, it, expect } from "vitest";
import { SEO_SOURCES, trendPoints, type SeoSource } from "@/services/seo/types";

describe("SEO_SOURCES", () => {
  it("lists every source exactly once", () => {
    const expected: SeoSource[] = [
      "rankmath_audit", "rankmath_scores", "links", "keywords", "ai_visibility", "psi",
    ];
    expect([...SEO_SOURCES].sort()).toEqual([...expected].sort());
    expect(new Set(SEO_SOURCES).size).toBe(SEO_SOURCES.length);
  });
});

describe("trendPoints", () => {
  const history = [
    { taken_at: "2026-08-01T00:00:00Z", payload: { status: "ok", data: { score: 61 } } },
    { taken_at: "2026-08-08T00:00:00Z", payload: { status: "error", reason: "boom" } },
    { taken_at: "2026-08-15T00:00:00Z", payload: { status: "ok", data: { score: 74 } } },
  ];
  const pick = (p: unknown) => {
    const d = (p as { data?: { score?: number | null } })?.data;
    return typeof d?.score === "number" ? d.score : null;
  };

  it("keeps only points with values, in order", () => {
    expect(trendPoints(history, pick)).toEqual([
      { at: "2026-08-01T00:00:00Z", value: 61 },
      { at: "2026-08-15T00:00:00Z", value: 74 },
    ]);
  });
  it("returns [] when nothing has a value", () => {
    expect(trendPoints([{ taken_at: "x", payload: { status: "error" } }], pick)).toEqual([]);
    expect(trendPoints([], pick)).toEqual([]);
  });
});
