import type { SupabaseClient } from "@supabase/supabase-js";
import type { InventoryPayload } from "./types";

export interface SnapshotsRepo {
  insertSnapshot(siteId: string, payload: InventoryPayload): Promise<void>;
  latestSnapshot(siteId: string): Promise<{ payload: InventoryPayload; taken_at: string } | null>;
}

export function supabaseSnapshotsRepo(db: SupabaseClient): SnapshotsRepo {
  return {
    async insertSnapshot(siteId, payload) {
      const { error } = await db.from("site_snapshots").insert({ site_id: siteId, payload });
      if (error) throw new Error(`insertSnapshot failed: ${error.message}`, { cause: error });
    },
    async latestSnapshot(siteId) {
      const { data, error } = await db.from("site_snapshots")
        .select("payload,taken_at").eq("site_id", siteId)
        .order("taken_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`latestSnapshot failed: ${error.message}`, { cause: error });
      return data ? { payload: data.payload as InventoryPayload, taken_at: data.taken_at } : null;
    },
  };
}
