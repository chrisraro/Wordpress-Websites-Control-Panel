import type { GridPoint } from "./types";

const METRES_PER_DEGREE_LAT = 111_320;
const ALLOWED_SIZES = new Set([3, 5, 7, 9]);

/**
 * Row-major grid from north-west to south-east, centred on the given point.
 * Longitude spacing widens with latitude so cells stay square on the ground.
 */
export function buildGrid(
  centerLat: number, centerLng: number, size: number, spacingM: number,
): GridPoint[] {
  if (!ALLOWED_SIZES.has(size)) {
    throw new Error(`Invalid grid size: ${size} (expected 3, 5, 7 or 9)`);
  }
  if (!Number.isFinite(spacingM) || spacingM <= 0) {
    throw new Error(`Invalid spacing: ${spacingM} (expected metres greater than zero)`);
  }
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) {
    throw new Error(`Invalid centre coordinate: ${centerLat}, ${centerLng}`);
  }
  const half = (size - 1) / 2;
  const dLat = spacingM / METRES_PER_DEGREE_LAT;
  const cos = Math.cos((centerLat * Math.PI) / 180);
  // Near the poles cos() approaches 0; clamp so longitude spacing stays finite.
  const dLng = spacingM / (METRES_PER_DEGREE_LAT * Math.max(Math.abs(cos), 1e-6));

  const points: GridPoint[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      points.push({
        idx: row * size + col,
        lat: centerLat + (half - row) * dLat,
        lng: centerLng + (col - half) * dLng,
      });
    }
  }
  return points;
}

export function gridBounds(points: GridPoint[]): {
  south: number; west: number; north: number; east: number;
} {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  return {
    south: Math.min(...lats), north: Math.max(...lats),
    west: Math.min(...lngs), east: Math.max(...lngs),
  };
}
