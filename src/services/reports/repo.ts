import type { SupabaseClient } from "@supabase/supabase-js";

export interface ReportRow {
  id: string;
  site_id: string;
  generated_at: string;
  sections: string[];
  period_start: string | null;
  period_end: string | null;
  storage_path: string;
  share_token: string | null;
  auto: boolean;
}

export interface ReportsRepo {
  insert(row: {
    site_id: string; sections: string[]; period_start: string; period_end: string;
    storage_path: string; share_token: string; auto: boolean;
  }): Promise<ReportRow>;
  listForSite(siteId: string, limit?: number): Promise<ReportRow[]>;
  getByToken(token: string): Promise<ReportRow | null>;
  revoke(id: string): Promise<void>;
  autoExistsSince(siteId: string, sinceIso: string): Promise<boolean>;
}

const COLUMNS =
  "id,site_id,generated_at,sections,period_start,period_end,storage_path,share_token,auto";

export function supabaseReportsRepo(db: SupabaseClient): ReportsRepo {
  return {
    async insert(row) {
      const { data, error } = await db.from("reports").insert(row).select(COLUMNS).single();
      if (error) throw new Error(`reports.insert failed: ${error.message}`, { cause: error });
      return data as ReportRow;
    },
    async listForSite(siteId, limit = 20) {
      const { data, error } = await db.from("reports").select(COLUMNS)
        .eq("site_id", siteId).order("generated_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`reports.listForSite failed: ${error.message}`, { cause: error });
      return (data ?? []) as ReportRow[];
    },
    async getByToken(token) {
      const { data, error } = await db.from("reports").select(COLUMNS)
        .eq("share_token", token).maybeSingle();
      if (error) throw new Error(`reports.getByToken failed: ${error.message}`, { cause: error });
      return (data as ReportRow) ?? null;
    },
    async revoke(id) {
      const { error } = await db.from("reports").update({ share_token: null }).eq("id", id);
      if (error) throw new Error(`reports.revoke failed: ${error.message}`, { cause: error });
    },
    async autoExistsSince(siteId, sinceIso) {
      const { count, error } = await db.from("reports").select("id", { head: true, count: "exact" })
        .eq("site_id", siteId).eq("auto", true).gte("generated_at", sinceIso);
      if (error) throw new Error(`reports.autoExistsSince failed: ${error.message}`, { cause: error });
      return (count ?? 0) > 0;
    },
  };
}

export interface ReportStorage {
  upload(path: string, pdf: Uint8Array): Promise<void>;
  download(path: string): Promise<Uint8Array>;
}

export function supabaseReportStorage(db: SupabaseClient): ReportStorage {
  return {
    async upload(path, pdf) {
      const { error } = await db.storage.from("reports")
        .upload(path, pdf, { contentType: "application/pdf", upsert: false });
      if (error) throw new Error(`report upload failed: ${error.message}`, { cause: error });
    },
    async download(path) {
      const { data, error } = await db.storage.from("reports").download(path);
      if (error || !data) throw new Error(`report download failed: ${error?.message ?? "missing"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
