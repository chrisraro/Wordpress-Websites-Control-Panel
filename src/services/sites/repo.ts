import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiteRow, SiteStatus } from "./types";

export interface SitesRepo {
  insertSite(row: {
    name: string; url: string; mcp_endpoint: string; wp_username: string;
    app_password_encrypted: string; client_label: string | null;
    capabilities: { abilities: string[] }; created_by: string;
  }): Promise<{ id: string }>;
  listSites(): Promise<SiteRow[]>;
  getSite(id: string): Promise<SiteRow | null>;
  getSiteCredentials(id: string): Promise<{
    mcp_endpoint: string; wp_username: string; app_password_encrypted: string;
  } | null>;
  getSiteConnection(id: string): Promise<{ mcp_endpoint: string; wp_username: string } | null>;
  updateSiteStatus(id: string, status: SiteStatus): Promise<void>;
  insertActivity(entry: {
    actor: string; site_id?: string; action: string; detail?: unknown;
  }): Promise<void>;
  recordScanResult(id: string, success: boolean): Promise<void>;
}

// mcp_endpoint and wp_username are deliberately absent: they are
// credential-adjacent, and this list is also selected by clients through
// the user-scoped client (readDbFor). See getSiteConnection below for the
// one staff-only surface that still needs them, and migration
// 0012_revoke_site_credential_columns.sql for the database-level backstop.
const SITE_COLUMNS =
  "id,name,url,status,client_label,capabilities,created_at,updated_at";

export function supabaseSitesRepo(db: SupabaseClient): SitesRepo {
  return {
    async insertSite(row) {
      const { data, error } = await db.from("sites").insert(row).select("id").single();
      if (error) throw new Error(`insertSite failed: ${error.message}`);
      return { id: data.id };
    },
    async listSites() {
      const { data, error } = await db.from("sites").select(SITE_COLUMNS).order("name");
      if (error) throw new Error(`listSites failed: ${error.message}`);
      return (data ?? []) as SiteRow[];
    },
    async getSite(id) {
      const { data, error } = await db.from("sites").select(SITE_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw new Error(`getSite failed: ${error.message}`);
      return (data as SiteRow) ?? null;
    },
    async getSiteCredentials(id) {
      const { data, error } = await db
        .from("sites")
        .select("mcp_endpoint,wp_username,app_password_encrypted")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`getSiteCredentials failed: ${error.message}`);
      return data ?? null;
    },
    async getSiteConnection(id) {
      const { data, error } = await db
        .from("sites")
        .select("mcp_endpoint,wp_username")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`getSiteConnection failed: ${error.message}`);
      return data ?? null;
    },
    async updateSiteStatus(id, status) {
      const { error } = await db.from("sites").update({ status }).eq("id", id);
      if (error) throw new Error(`updateSiteStatus failed: ${error.message}`);
    },
    async insertActivity(entry) {
      const { error } = await db.from("activity_log").insert({
        actor: entry.actor,
        site_id: entry.site_id ?? null,
        action: entry.action,
        detail: entry.detail ?? null,
      });
      if (error) throw new Error(`insertActivity failed: ${error.message}`);
    },
    async recordScanResult(id, success) {
      const { data, error } = await db.from("sites")
        .select("consecutive_failures,status").eq("id", id).maybeSingle();
      if (error) throw new Error(`recordScanResult read failed: ${error.message}`, { cause: error });
      if (!data) return;
      if (success) {
        const patch: Record<string, unknown> = { consecutive_failures: 0 };
        if (data.status === "degraded") patch.status = "connected";
        const { error: e2 } = await db.from("sites").update(patch).eq("id", id);
        if (e2) throw new Error(`recordScanResult failed: ${e2.message}`, { cause: e2 });
      } else {
        const failures = (data.consecutive_failures ?? 0) + 1;
        const patch: Record<string, unknown> = { consecutive_failures: failures };
        if (failures >= 3 && data.status === "connected") patch.status = "degraded";
        const { error: e2 } = await db.from("sites").update(patch).eq("id", id);
        if (e2) throw new Error(`recordScanResult failed: ${e2.message}`, { cause: e2 });
      }
    },
  };
}
