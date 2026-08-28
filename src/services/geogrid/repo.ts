import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  GeoGridConfig, GeoGridProviderName, GeoGridSnapshot, RankPoint,
} from "./types";

export interface GeoGridConfigInput {
  business_name: string;
  place_ref: string | null;
  keywords: string[];
  grid_size: number;
  spacing_m: number;
  center_lat: number;
  center_lng: number;
  provider: GeoGridProviderName;
}

export interface GeoGridRepo {
  getConfigBySite(siteId: string): Promise<GeoGridConfig | null>;
  getConfig(configId: string): Promise<GeoGridConfig | null>;
  upsertConfig(siteId: string, input: GeoGridConfigInput): Promise<GeoGridConfig>;
  insertSnapshot(configId: string, keyword: string, points: RankPoint[]): Promise<void>;
  latestPerKeyword(configId: string): Promise<Record<string, GeoGridSnapshot>>;
  historyForKeyword(configId: string, keyword: string, limit?: number): Promise<GeoGridSnapshot[]>;
}

const CONFIG_COLUMNS =
  "id,site_id,business_name,place_ref,keywords,grid_size,spacing_m,center_lat,center_lng,provider,created_at";

export function supabaseGeoGridRepo(db: SupabaseClient): GeoGridRepo {
  return {
    async getConfigBySite(siteId) {
      const { data, error } = await db.from("geogrid_configs").select(CONFIG_COLUMNS)
        .eq("site_id", siteId).order("created_at").limit(1).maybeSingle();
      if (error) throw new Error(`getConfigBySite failed: ${error.message}`, { cause: error });
      return (data as GeoGridConfig) ?? null;
    },
    async getConfig(configId) {
      const { data, error } = await db.from("geogrid_configs").select(CONFIG_COLUMNS)
        .eq("id", configId).maybeSingle();
      if (error) throw new Error(`getConfig failed: ${error.message}`, { cause: error });
      return (data as GeoGridConfig) ?? null;
    },
    async upsertConfig(siteId, input) {
      const existing = await this.getConfigBySite(siteId);
      const row = { site_id: siteId, ...input };
      const query = existing
        ? db.from("geogrid_configs").update(row).eq("id", existing.id)
        : db.from("geogrid_configs").insert(row);
      const { data, error } = await query.select(CONFIG_COLUMNS).single();
      if (error) throw new Error(`upsertConfig failed: ${error.message}`, { cause: error });
      return data as GeoGridConfig;
    },
    async insertSnapshot(configId, keyword, points) {
      const { error } = await db.from("geogrid_snapshots")
        .insert({ config_id: configId, keyword, points });
      if (error) throw new Error(`insertSnapshot failed: ${error.message}`, { cause: error });
    },
    async latestPerKeyword(configId) {
      const { data, error } = await db.from("geogrid_snapshots")
        .select("id,config_id,run_at,keyword,points").eq("config_id", configId)
        .order("run_at", { ascending: false }).limit(200);
      if (error) throw new Error(`latestPerKeyword failed: ${error.message}`, { cause: error });
      const out: Record<string, GeoGridSnapshot> = {};
      for (const row of (data ?? []) as GeoGridSnapshot[]) {
        if (!out[row.keyword]) out[row.keyword] = row;
      }
      return out;
    },
    async historyForKeyword(configId, keyword, limit = 10) {
      const { data, error } = await db.from("geogrid_snapshots")
        .select("id,config_id,run_at,keyword,points")
        .eq("config_id", configId).eq("keyword", keyword)
        .order("run_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`historyForKeyword failed: ${error.message}`, { cause: error });
      return (data ?? []) as GeoGridSnapshot[];
    },
  };
}
