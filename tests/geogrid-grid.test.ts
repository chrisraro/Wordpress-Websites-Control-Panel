import { describe, it, expect } from "vitest";
import { buildGrid, gridBounds } from "@/services/geogrid/grid";
import { averageRank, coverage, type RankPoint } from "@/services/geogrid/types";

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
    const dLat = pts[1 * 3].lat - pts[0 * 3 + 3].lat; // adjacent rows
    expect(Math.abs(pts[0].lat - pts[3].lat)).toBeCloseTo(spacing / 111_320, 6);
    expect(Math.abs(pts[0].lng - pts[1].lng)).toBeCloseTo(spacing / 111_320, 6);
    expect(dLat).toBeCloseTo(0, 9);
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
