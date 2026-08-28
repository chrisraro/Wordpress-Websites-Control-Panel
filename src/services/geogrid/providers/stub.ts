import type { GeoGridProvider, RankPoint } from "../types";

/** Small deterministic string hash (FNV-1a, 32-bit). */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h >>> 0);
}

/**
 * Deterministic stand-in for a real rank provider: ranks degrade with distance
 * from the centre, so the map looks like a plausible local-pack heat map.
 */
export const stubProvider: GeoGridProvider = {
  name: "stub",
  async run(req) {
    const size = Math.round(Math.sqrt(req.points.length));
    const half = (size - 1) / 2;
    const ranks: RankPoint[] = req.points.map((p) => {
      const row = Math.floor(p.idx / size);
      const col = p.idx % size;
      const ring = Math.max(Math.abs(row - half), Math.abs(col - half));
      const jitter = hash(`${req.keyword}|${p.idx}`) % 3;
      const rank = 1 + jitter + ring * 3;
      return { ...p, rank: rank > 20 ? null : rank };
    });
    return { kind: "ranks", ranks };
  },
};
