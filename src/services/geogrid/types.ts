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
export interface RankPoint extends GridPoint { rank: number | null }

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

export function coverage(points: RankPoint[]): number {
  if (points.length === 0) return 0;
  const found = points.filter((p) => typeof p.rank === "number").length;
  return Math.round((found / points.length) * 100);
}
