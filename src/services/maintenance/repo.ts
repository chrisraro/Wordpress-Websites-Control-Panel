import type { SupabaseClient } from "@supabase/supabase-js";
import { windowFromRow, type MaintenanceWindow, type WindowRow } from "./window";

const WINDOW_COLUMNS =
  "id,maintenance_days,maintenance_start,maintenance_duration_minutes,maintenance_timezone";

/**
 * Per-site maintenance windows (0027_site_maintenance_window.sql).
 *
 * Service-role only: the columns are not granted to `authenticated` and are
 * not in SITE_COLUMNS, so a client-scoped client would have the whole select
 * refused. Every caller is a staff surface or a staff-gated action.
 */
export interface MaintenanceRepo {
  getWindow(siteId: string): Promise<MaintenanceWindow | null>;
  /** Every requested site appears in the map; `null` means no window. */
  listWindows(siteIds: string[]): Promise<Map<string, MaintenanceWindow | null>>;
  setWindow(siteId: string, window: MaintenanceWindow | null): Promise<void>;
}

export function supabaseMaintenanceRepo(db: SupabaseClient): MaintenanceRepo {
  return {
    async getWindow(siteId) {
      const { data, error } = await db.from("sites").select(WINDOW_COLUMNS).eq("id", siteId).maybeSingle();
      if (error) throw new Error(`getWindow failed: ${error.message}`, { cause: error });
      return data ? windowFromRow(data as WindowRow) : null;
    },
    async listWindows(siteIds) {
      const out = new Map<string, MaintenanceWindow | null>(siteIds.map((id) => [id, null]));
      if (siteIds.length === 0) return out;
      const { data, error } = await db.from("sites").select(WINDOW_COLUMNS).in("id", siteIds);
      if (error) throw new Error(`listWindows failed: ${error.message}`, { cause: error });
      for (const row of data ?? []) {
        out.set(row.id as string, windowFromRow(row as WindowRow));
      }
      return out;
    },
    async setWindow(siteId, window) {
      const patch = window
        ? {
            maintenance_days: window.days,
            maintenance_start: window.start,
            maintenance_duration_minutes: window.durationMinutes,
            maintenance_timezone: window.timeZone,
          }
        // The zone is left as it was: it is NOT NULL, and keeping it means
        // re-enabling a window starts from the zone last chosen.
        : { maintenance_days: null, maintenance_start: null, maintenance_duration_minutes: null };
      const { error } = await db.from("sites").update(patch).eq("id", siteId);
      if (error) throw new Error(`setWindow failed: ${error.message}`, { cause: error });
    },
  };
}
