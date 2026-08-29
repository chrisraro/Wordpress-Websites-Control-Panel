import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminUser, InventoryPayload } from "./types";

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

/**
 * `site_admin_users` (0011_site_admin_users.sql): staff-only, one row per
 * site, replaced wholesale on each inventory refresh -- see spec §5.1.
 * Written exclusively by the service-role collector; read by the site
 * overview page's Administrators card, gated there on `canViewAdminUsers`
 * (`can(viewer, "sites.view_all")` in sites/[id]/page.tsx), not a role check.
 */
export interface AdminUsersRepo {
  upsertAdminUsers(siteId: string, users: AdminUser[]): Promise<void>;
  latestAdminUsers(siteId: string): Promise<{ users: AdminUser[]; collectedAt: string } | null>;
}

export function supabaseAdminUsersRepo(db: SupabaseClient): AdminUsersRepo {
  return {
    async upsertAdminUsers(siteId, users) {
      const { error } = await db.from("site_admin_users")
        .upsert(
          { site_id: siteId, users, collected_at: new Date().toISOString() },
          { onConflict: "site_id" },
        );
      if (error) throw new Error(`upsertAdminUsers failed: ${error.message}`, { cause: error });
    },
    async latestAdminUsers(siteId) {
      const { data, error } = await db.from("site_admin_users")
        .select("users,collected_at").eq("site_id", siteId).maybeSingle();
      if (error) throw new Error(`latestAdminUsers failed: ${error.message}`, { cause: error });
      return data ? { users: data.users as AdminUser[], collectedAt: data.collected_at } : null;
    },
  };
}
