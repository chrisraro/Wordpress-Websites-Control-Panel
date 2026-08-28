"use server";

import { revalidatePath } from "next/cache";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import type { GeoGridProviderName } from "@/services/geogrid/types";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createServiceSupabase, requireUser } from "@/lib/supabase/server";

const SIZES = new Set([3, 5, 7, 9]);

export async function saveGeoGridConfigAction(
  siteId: string, formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  const businessName = String(formData.get("business_name") ?? "").trim();
  const placeRefRaw = String(formData.get("place_ref") ?? "").trim();
  const keywords = [...new Set(
    String(formData.get("keywords") ?? "").split(",").map((k) => k.trim()).filter(Boolean),
  )];
  const gridSize = Number(formData.get("grid_size"));
  const spacing = Number(formData.get("spacing_m"));
  const lat = Number(formData.get("center_lat"));
  const lng = Number(formData.get("center_lng"));
  const provider = String(formData.get("provider") ?? "stub") as GeoGridProviderName;

  if (!businessName) return { ok: false, error: "Business name is required" };
  if (keywords.length === 0) return { ok: false, error: "Add at least one keyword" };
  if (keywords.length > 10) return { ok: false, error: "Ten keywords maximum" };
  if (!SIZES.has(gridSize)) return { ok: false, error: "Grid size must be 3, 5, 7 or 9" };
  if (!Number.isFinite(spacing) || spacing < 100 || spacing > 20_000) {
    return { ok: false, error: "Spacing must be between 100 and 20000 metres" };
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: "Latitude must be between -90 and 90" };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: "Longitude must be between -180 and 180" };
  if (provider !== "stub" && provider !== "n8n") return { ok: false, error: "Unknown provider" };

  const db = createServiceSupabase();
  try {
    await supabaseGeoGridRepo(db).upsertConfig(siteId, {
      business_name: businessName,
      place_ref: placeRefRaw || null,
      keywords,
      grid_size: gridSize,
      spacing_m: Math.round(spacing),
      center_lat: lat,
      center_lng: lng,
      provider,
    });
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.geogrid_config",
      detail: { keywords: keywords.length, grid_size: gridSize, provider },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save configuration" };
  }
  revalidatePath(`/sites/${siteId}/geogrid`);
  return { ok: true };
}

export async function runGeoGridAction(
  siteId: string,
): Promise<{ ok: boolean; error?: string; queued?: number }> {
  const user = await requireUser();
  const db = createServiceSupabase();
  const config = await supabaseGeoGridRepo(db).getConfigBySite(siteId);
  if (!config) return { ok: false, error: "Save a GeoGrid configuration first" };
  if (config.keywords.length === 0) return { ok: false, error: "Add at least one keyword" };

  try {
    const jobs = supabaseJobsRepo(db);
    const batchId = crypto.randomUUID();
    for (const keyword of config.keywords) {
      await jobs.insert({
        type: "geogrid_run", site_id: siteId, batch_id: batchId,
        payload: { config_id: config.id, keyword },
      });
    }
    await supabaseSitesRepo(db).insertActivity({
      actor: user.id, site_id: siteId, action: "site.geogrid_run",
      detail: { keywords: config.keywords.length, provider: config.provider },
    });
    revalidatePath(`/sites/${siteId}/geogrid`);
    return { ok: true, queued: config.keywords.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not queue the run" };
  }
}
