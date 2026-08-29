export type GeoGridProviderName = "stub" | "n8n";

export interface GeoGridConfig {
  id: string;
  site_id: string;
  business_name: string;
  place_ref: string | null;
  keywords: string[];
  grid_size: number;
  spacing_m: number;
  center_lat: number;
  center_lng: number;
  provider: GeoGridProviderName;
  created_at: string;
}

export interface GridPoint { idx: number; lat: number; lng: number }
/**
 * `measured` is optional and defaults to "measured" when absent: every
 * snapshot written before this field existed was all-or-nothing (n8n refused
 * to post partial results), so old rows read correctly with no backfill.
 * Only `measured === false` means "no data for this point" — a lookup that
 * failed or was never reported, not a business that doesn't rank.
 */
export interface RankPoint extends GridPoint { rank: number | null; measured?: boolean }

export interface GeoGridSnapshot {
  id: string;
  config_id: string;
  run_at: string;
  keyword: string;
  points: RankPoint[];
}

export interface ProviderRequest {
  runId: string;
  keyword: string;
  businessName: string;
  placeRef: string | null;
  points: GridPoint[];
  callbackUrl: string;
}

export type ProviderOutcome =
  | { kind: "ranks"; ranks: RankPoint[] }
  | { kind: "awaiting" };

export interface GeoGridProvider {
  name: GeoGridProviderName;
  run(req: ProviderRequest): Promise<ProviderOutcome>;
}

export function averageRank(points: RankPoint[]): number | null {
  const found = points.filter((p) => typeof p.rank === "number").map((p) => p.rank as number);
  if (found.length === 0) return null;
  const mean = found.reduce((a, b) => a + b, 0) / found.length;
  return Math.round(mean * 10) / 10;
}

/** Points with an actual measurement, whether or not they ranked. */
export function measuredCount(points: RankPoint[]): number {
  return points.filter((p) => p.measured !== false).length;
}

/**
 * Coverage excludes unmeasured points from both sides of the ratio: a point
 * whose lookup failed carries no information about whether the business
 * ranks there, so it must not be counted as "not in the top 20" (numerator)
 * nor allowed to dilute the denominator as if it had been checked.
 */
export function coverage(points: RankPoint[]): number {
  const measured = points.filter((p) => p.measured !== false);
  if (measured.length === 0) return 0;
  const found = measured.filter((p) => typeof p.rank === "number").length;
  return Math.round((found / measured.length) * 100);
}
