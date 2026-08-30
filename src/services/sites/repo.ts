import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiteCredentials, SiteEnvironment, SiteRow, SiteStatus } from "./types";

export interface SitesRepo {
  insertSite(row: {
    name: string; url: string; mcp_endpoint: string; wp_username: string;
    app_password_encrypted: string; client_label: string | null;
    environment: SiteEnvironment;
    capabilities: { abilities: string[] }; created_by: string;
  }): Promise<{ id: string }>;
  listSites(): Promise<SiteRow[]>;
  getSite(id: string): Promise<SiteRow | null>;
  getSiteCredentials(id: string): Promise<SiteCredentials | null>;
  getSiteConnection(id: string): Promise<{
    mcp_endpoint: string; wp_username: string;
    origin_ip: string | null; origin_sni: string | null;
  } | null>;
  updateSiteStatus(id: string, status: SiteStatus): Promise<void>;
  setSiteEnvironment(id: string, environment: SiteEnvironment): Promise<void>;
  /** Both or neither — see 0019_site_origin_override.sql. */
  setSiteOrigin(id: string, origin: { ip: string; sni: string } | null): Promise<void>;
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
// `environment` requires 0017_site_environment.sql. PostgREST rejects a
// select naming an unknown column and fails the WHOLE query, so this line is
// the hard deploy-order dependency that migration documents.
const SITE_COLUMNS =
  "id,name,url,status,environment,client_label,capabilities,created_at,updated_at";

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
        // origin_ip/origin_sni ride along here rather than in SITE_COLUMNS:
        // they describe how to reach the origin directly, which is
        // credential-adjacent and staff-only (see 0019). This read goes
        // through the service-role client.
        .select("mcp_endpoint,wp_username,app_password_encrypted,origin_ip,origin_sni")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`getSiteCredentials failed: ${error.message}`);
      return data ?? null;
    },
    async getSiteConnection(id) {
      const { data, error } = await db
        .from("sites")
        .select("mcp_endpoint,wp_username,origin_ip,origin_sni")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`getSiteConnection failed: ${error.message}`);
      return data ?? null;
    },
    async setSiteEnvironment(id, environment) {
      const { error } = await db.from("sites").update({ environment }).eq("id", id);
      if (error) throw new Error(`setSiteEnvironment failed: ${error.message}`);
    },
    async setSiteOrigin(id, origin) {
      const { error } = await db.from("sites")
        .update({ origin_ip: origin?.ip ?? null, origin_sni: origin?.sni ?? null })
        .eq("id", id);
      if (error) throw new Error(`setSiteOrigin failed: ${error.message}`);
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
