import type { SupabaseClient } from "@supabase/supabase-js";
import { shareLinkState } from "./share";

export interface ReportRow {
  id: string;
  site_id: string;
  generated_at: string;
  sections: string[];
  period_start: string | null;
  period_end: string | null;
  storage_path: string;
  share_token: string | null;
  /** When the share link stops working. Null = no expiry (links minted before 0024). */
  share_expires_at: string | null;
  auto: boolean;
  /** Security coverage gaps at generation time; see migration 0024. */
  security_incomplete: string[] | null;
}

export interface ReportsRepo {
  insert(row: {
    site_id: string; sections: string[]; period_start: string; period_end: string;
    storage_path: string; share_token: string | null; share_expires_at: string | null;
    auto: boolean; security_incomplete: string[] | null;
  }): Promise<ReportRow>;
  listForSite(siteId: string, limit?: number): Promise<ReportRow[]>;
  /** The report behind a LIVE link: null when unknown, revoked or expired alike. */
  getByToken(token: string): Promise<ReportRow | null>;
  getById(id: string): Promise<ReportRow | null>;
  revoke(id: string, siteId: string): Promise<void>;
  /** Replaces the report's link with a new token and expiry. */
  setShareLink(id: string, siteId: string, token: string, expiresAt: string): Promise<void>;
  autoExistsSince(siteId: string, sinceIso: string): Promise<boolean>;
}

// share_expires_at and security_incomplete require
// 0024_report_share_expiry_and_coverage.sql: PostgREST rejects a select
// naming an unknown column, so apply it first.
// One literal, not a concatenation: supabase-js parses the select string at
// the type level, and a widened `string` would lose the row typing.
const COLUMNS =
  "id,site_id,generated_at,sections,period_start,period_end,storage_path,share_token,share_expires_at,auto,security_incomplete";

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
      const report = (data as ReportRow) ?? null;
      // Expired is indistinguishable from revoked or unknown to every caller
      // (the public page and PDF route both 404 uniformly on null).
      return report && shareLinkState(report) === "active" ? report : null;
    },
    async getById(id) {
      const { data, error } = await db.from("reports").select(COLUMNS)
        .eq("id", id).maybeSingle();
      if (error) throw new Error(`reports.getById failed: ${error.message}`, { cause: error });
      return (data as ReportRow) ?? null;
    },
    async revoke(id, siteId) {
      // Scoped to both id and site_id: revokeReportAction checks the caller's
      // access to `siteId`, not to whatever site the report at `id` actually
      // belongs to. Without this second predicate, a caller holding access to
      // one site could pass a reportId belonging to a different site and have
      // it revoked anyway.
      const { error } = await db.from("reports").update({ share_token: null })
        .eq("id", id).eq("site_id", siteId);
      if (error) throw new Error(`reports.revoke failed: ${error.message}`, { cause: error });
    },
    async setShareLink(id, siteId, token, expiresAt) {
      // Same id + site_id scoping as revoke, for the same reason.
      const { error } = await db.from("reports")
        .update({ share_token: token, share_expires_at: expiresAt })
        .eq("id", id).eq("site_id", siteId);
      if (error) throw new Error(`reports.setShareLink failed: ${error.message}`, { cause: error });
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
