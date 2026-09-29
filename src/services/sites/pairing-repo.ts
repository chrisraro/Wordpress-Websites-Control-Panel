import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Staging ↔ production pairing (0026_site_production_pair.sql).
 *
 * Separate from SitesRepo on purpose: `production_site_id` is NOT in
 * SITE_COLUMNS and NOT granted to `authenticated`, so every read here must
 * go through the service-role client on a staff surface. Keeping it out of
 * the shared select list is what keeps a client from ever selecting it.
 */
export interface PairingRepo {
  getProductionSiteId(siteId: string): Promise<string | null>;
  /** Staging copies that name `productionId` as their production site. */
  listStagingPairs(productionId: string): Promise<{ id: string; name: string }[]>;
  setProductionSiteId(siteId: string, productionId: string | null): Promise<void>;
}

export function supabasePairingRepo(db: SupabaseClient): PairingRepo {
  return {
    async getProductionSiteId(siteId) {
      const { data, error } = await db.from("sites")
        .select("production_site_id").eq("id", siteId).maybeSingle();
      if (error) throw new Error(`getProductionSiteId failed: ${error.message}`, { cause: error });
      return (data?.production_site_id as string | null | undefined) ?? null;
    },
    async listStagingPairs(productionId) {
      const { data, error } = await db.from("sites")
        .select("id,name,environment").eq("production_site_id", productionId).order("name");
      if (error) throw new Error(`listStagingPairs failed: ${error.message}`, { cause: error });
      // A row re-marked production keeps its column value; it is no longer
      // anyone's staging copy (see effectivePairId).
      return (data ?? [])
        .filter((r) => r.environment !== "production")
        .map((r) => ({ id: r.id as string, name: r.name as string }));
    },
    async setProductionSiteId(siteId, productionId) {
      const { error } = await db.from("sites")
        .update({ production_site_id: productionId }).eq("id", siteId);
      if (error) throw new Error(`setProductionSiteId failed: ${error.message}`, { cause: error });
    },
  };
}
