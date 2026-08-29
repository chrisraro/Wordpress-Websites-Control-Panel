import { describe, it, expect } from "vitest";
import { buildGrid, gridBounds } from "@/services/geogrid/grid";
import {
  averageRank, coverage, measuredCount, resolveRunPreview,
  type GeoGridSnapshot, type RankPoint,
} from "@/services/geogrid/types";

describe("buildGrid", () => {
  it("builds N*N points with the centre exactly in the middle", () => {
    const pts = buildGrid(14.5995, 120.9842, 3, 1000);
    expect(pts).toHaveLength(9);
    expect(pts.map((p) => p.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const centre = pts[4];
    expect(centre.lat).toBeCloseTo(14.5995, 9);
    expect(centre.lng).toBeCloseTo(120.9842, 9);
  });

  it("orders points north-west to south-east, row major", () => {
    const pts = buildGrid(10, 20, 3, 1000);
    expect(pts[0].lat).toBeGreaterThan(pts[6].lat);   // first row north of last row
    expect(pts[0].lng).toBeLessThan(pts[2].lng);      // first column west of last column
    expect(pts[0].lat).toBeCloseTo(pts[1].lat, 9);    // same row shares latitude
    expect(pts[0].lng).toBeCloseTo(pts[3].lng, 9);    // same column shares longitude
  });

  it("spaces points by the requested metres", () => {
    const spacing = 1000;
    const pts = buildGrid(0, 0, 3, spacing);          // at the equator cos(0)=1
    const expected = spacing / 111_320;
    // adjacent rows, same column (idx 0 -> 3 -> 6) step by one spacing each
    expect(Math.abs(pts[0].lat - pts[3].lat)).toBeCloseTo(expected, 6);
    expect(Math.abs(pts[3].lat - pts[6].lat)).toBeCloseTo(expected, 6);
    // adjacent columns, same row
    expect(Math.abs(pts[0].lng - pts[1].lng)).toBeCloseTo(expected, 6);
    expect(Math.abs(pts[1].lng - pts[2].lng)).toBeCloseTo(expected, 6);
    // every point in a row shares one latitude
    expect(pts[3].lat).toBeCloseTo(pts[5].lat, 9);
  });

  it("rejects non-finite coordinates", () => {
    expect(() => buildGrid(Number.NaN, 0, 3, 1000)).toThrow(/coordinate/i);
    expect(() => buildGrid(0, Number.POSITIVE_INFINITY, 3, 1000)).toThrow(/coordinate/i);
  });

  it("widens longitude spacing away from the equator", () => {
    const equator = buildGrid(0, 0, 3, 1000);
    const north = buildGrid(60, 0, 3, 1000);
    const dLngEq = Math.abs(equator[0].lng - equator[1].lng);
    const dLngN = Math.abs(north[0].lng - north[1].lng);
    expect(dLngN).toBeGreaterThan(dLngEq * 1.9);      // 1/cos(60°) = 2
  });

  it("rejects invalid sizes", () => {
    for (const bad of [0, 2, 4, 11, -3]) {
      expect(() => buildGrid(0, 0, bad, 1000)).toThrow(/grid size/i);
    }
    expect(() => buildGrid(0, 0, 5, 0)).toThrow(/spacing/i);
  });
});

describe("gridBounds", () => {
  it("returns the enclosing box", () => {
    const b = gridBounds(buildGrid(10, 20, 3, 1000));
    expect(b.north).toBeGreaterThan(b.south);
    expect(b.east).toBeGreaterThan(b.west);
    expect((b.north + b.south) / 2).toBeCloseTo(10, 6);
    expect((b.east + b.west) / 2).toBeCloseTo(20, 6);
  });
});

describe("averageRank / coverage", () => {
  const pts: RankPoint[] = [
    { idx: 0, lat: 0, lng: 0, rank: 1 },
    { idx: 1, lat: 0, lng: 0, rank: 4 },
    { idx: 2, lat: 0, lng: 0, rank: null },
    { idx: 3, lat: 0, lng: 0, rank: 10 },
  ];
  it("averages only found ranks", () => {
    expect(averageRank(pts)).toBe(5);
  });
  it("reports coverage as a whole percentage", () => {
    expect(coverage(pts)).toBe(75);
  });
  it("handles an all-missing grid", () => {
    const none: RankPoint[] = [{ idx: 0, lat: 0, lng: 0, rank: null }];
    expect(averageRank(none)).toBeNull();
    expect(coverage(none)).toBe(0);
    expect(coverage([])).toBe(0);
  });
});

describe("measuredCount / coverage with unmeasured points", () => {
  it("counts every point whose measured flag is not explicitly false", () => {
    const pts: RankPoint[] = [
      { idx: 0, lat: 0, lng: 0, rank: 1 },                       // measured absent -> measured
      { idx: 1, lat: 0, lng: 0, rank: null, measured: true },    // explicit true -> measured
      { idx: 2, lat: 0, lng: 0, rank: null, measured: false },   // failed lookup -> unmeasured
    ];
    expect(measuredCount(pts)).toBe(2);
  });

  it("excludes unmeasured points from both sides of the coverage ratio", () => {
    // 1 of 2 *measured* points ranks -> 50%, not 1 of 3 (33%) and not 1 of 2
    // measured-as-denominator-only either: the unmeasured point must not
    // appear in the numerator or the denominator.
    const pts: RankPoint[] = [
      { idx: 0, lat: 0, lng: 0, rank: 1 },
      { idx: 1, lat: 0, lng: 0, rank: null },
      { idx: 2, lat: 0, lng: 0, rank: null, measured: false },
    ];
    expect(coverage(pts)).toBe(50);
  });

  it("reports 0% coverage when every point is unmeasured, not a divide-by-zero crash", () => {
    const pts: RankPoint[] = [
      { idx: 0, lat: 0, lng: 0, rank: null, measured: false },
      { idx: 1, lat: 0, lng: 0, rank: null, measured: false },
    ];
    expect(measuredCount(pts)).toBe(0);
    expect(coverage(pts)).toBe(0);
  });

  it("never lets a rank on an unmeasured point feed the average, even if one is present", () => {
    // A stale/partial rank sent alongside measured:false is not data — see
    // averageRank's `measured !== false` filter, which must reject the rank
    // itself, not just rely on the writer having already nulled it out.
    const pts: RankPoint[] = [
      { idx: 0, lat: 0, lng: 0, rank: 1 },
      { idx: 1, lat: 0, lng: 0, rank: 5, measured: false },
    ];
    expect(averageRank(pts)).toBe(1);
  });

  it("treats every point as measured on a pre-existing snapshot with no measured field at all", () => {
    const legacy: RankPoint[] = [
      { idx: 0, lat: 0, lng: 0, rank: 2 },
      { idx: 1, lat: 0, lng: 0, rank: null },
    ];
    expect(measuredCount(legacy)).toBe(legacy.length);
    expect(coverage(legacy)).toBe(50);
  });
});

describe("resolveRunPreview", () => {
  // history is newest-first, exactly as GeoGridRepo.historyForKeyword returns it.
  const history: GeoGridSnapshot[] = [
    { id: "snap-latest", config_id: "cfg-1", keyword: "coffee shop", run_at: "2026-03-03T00:00:00Z", points: [] },
    { id: "snap-mid", config_id: "cfg-1", keyword: "coffee shop", run_at: "2026-03-02T00:00:00Z", points: [] },
    { id: "snap-oldest", config_id: "cfg-1", keyword: "coffee shop", run_at: "2026-03-01T00:00:00Z", points: [] },
  ];

  it("defaults to the latest run when no id is requested", () => {
    const res = resolveRunPreview(history, undefined);
    expect(res).toEqual({ snapshot: history[0], index: 0, isPast: false });
  });

  it("resolves a requested id to its run and index", () => {
    const res = resolveRunPreview(history, "snap-mid");
    expect(res).toEqual({ snapshot: history[1], index: 1, isPast: true });
  });

  it("does not flag the latest run as past even when its id is requested explicitly", () => {
    const res = resolveRunPreview(history, "snap-latest");
    expect(res).toEqual({ snapshot: history[0], index: 0, isPast: false });
  });

  it("flags the oldest loaded run as past too", () => {
    const res = resolveRunPreview(history, "snap-oldest");
    expect(res).toEqual({ snapshot: history[2], index: 2, isPast: true });
  });

  it("falls back to the latest run for an id that isn't in the loaded history", () => {
    // Covers both a stale bookmark for a run that scrolled out of the kept
    // window and an id copied from a different keyword's history.
    const res = resolveRunPreview(history, "not-a-real-snapshot-id");
    expect(res).toEqual({ snapshot: history[0], index: 0, isPast: false });
  });

  it("returns no snapshot and index -1 for empty history", () => {
    expect(resolveRunPreview([], undefined)).toEqual({ snapshot: undefined, index: -1, isPast: false });
    expect(resolveRunPreview([], "anything")).toEqual({ snapshot: undefined, index: -1, isPast: false });
  });
});
