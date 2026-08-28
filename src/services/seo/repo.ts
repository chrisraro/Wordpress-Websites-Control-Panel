import type { SupabaseClient } from "@supabase/supabase-js";
import type { SeoSource, SourceResult } from "./types";

export interface SeoSnapshotRow { taken_at: string; source: SeoSource; payload: unknown }

export interface SeoRepo {
  insertSnapshots(siteId: string, takenAt: string, results: SourceResult[]): Promise<void>;
  latestBySource(siteId: string): Promise<Partial<Record<SeoSource, SeoSnapshotRow>>>;
  history(siteId: string, source: SeoSource, limit?: number): Promise<SeoSnapshotRow[]>;
  latestAuditScore(siteId: string): Promise<number | null>;
  lastRunAt(siteId: string): Promise<string | null>;
}

export function supabaseSeoRepo(db: SupabaseClient): SeoRepo {
  return {
    async insertSnapshots(siteId, takenAt, results) {
      if (results.length === 0) return;
      const rows = results.map((r) => ({
        site_id: siteId,
        taken_at: takenAt,
        source: r.source,
        payload: { status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.data !== undefined ? { data: r.data } : {}) },
      }));
      const { error } = await db.from("seo_snapshots").insert(rows);
      if (error) throw new Error(`seo_snapshots insert failed: ${error.message}`, { cause: error });
    },
    async latestBySource(siteId) {
      // Newest 60 rows covers ~10 runs of 6 sources; first row per source wins.
      const { data, error } = await db.from("seo_snapshots")
        .select("taken_at,source,payload").eq("site_id", siteId)
        .order("taken_at", { ascending: false }).limit(60);
      if (error) throw new Error(`latestBySource failed: ${error.message}`, { cause: error });
      const out: Partial<Record<SeoSource, SeoSnapshotRow>> = {};
      for (const row of data ?? []) {
        const source = row.source as SeoSource;
        if (!out[source]) out[source] = row as SeoSnapshotRow;
      }
      return out;
    },
    async history(siteId, source, limit = 20) {
      const { data, error } = await db.from("seo_snapshots")
        .select("taken_at,source,payload").eq("site_id", siteId).eq("source", source)
        .order("taken_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`seo history failed: ${error.message}`, { cause: error });
      return ((data ?? []) as SeoSnapshotRow[]).reverse();
    },
    async latestAuditScore(siteId) {
      const { data, error } = await db.from("seo_snapshots")
        .select("payload").eq("site_id", siteId).eq("source", "rankmath_audit")
        .order("taken_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`latestAuditScore failed: ${error.message}`, { cause: error });
      const score = (data?.payload as { data?: { score?: unknown } } | null)?.data?.score;
      return typeof score === "number" ? score : null;
    },
    async lastRunAt(siteId) {
      const { data, error } = await db.from("seo_snapshots")
        .select("taken_at").eq("site_id", siteId)
        .order("taken_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`seo lastRunAt failed: ${error.message}`, { cause: error });
      return data?.taken_at ?? null;
    },
  };
}
