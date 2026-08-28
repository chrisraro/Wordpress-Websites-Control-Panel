import type { GeoGridConfigInput } from "./repo";
import type { GeoGridProviderName } from "./types";

const SIZES = new Set([3, 5, 7, 9]);

export type ParseResult =
  | { ok: true; value: GeoGridConfigInput }
  | { ok: false; error: string };

/**
 * Validate a GeoGrid config submission. Kept free of server-action wiring so the
 * rules are unit-testable — including the "not a FormData at all" case, which a
 * mis-wired action can produce.
 */
export function parseGeoGridConfigForm(formData: unknown): ParseResult {
  if (!formData || typeof (formData as FormData).get !== "function") {
    return { ok: false, error: "Form data missing — please resubmit the form" };
  }
  const form = formData as FormData;
  const text = (name: string) => String(form.get(name) ?? "").trim();
  // Number("") is 0, so an empty coordinate would otherwise pass a range check
  // and silently save as 0,0.
  const num = (name: string) => (text(name) === "" ? Number.NaN : Number(text(name)));

  const businessName = text("business_name");
  const placeRef = text("place_ref");
  const keywords = [...new Set(text("keywords").split(",").map((k) => k.trim()).filter(Boolean))];
  const gridSize = num("grid_size");
  const spacing = num("spacing_m");
  const lat = num("center_lat");
  const lng = num("center_lng");
  const provider = (text("provider") || "stub") as GeoGridProviderName;

  if (!businessName) return { ok: false, error: "Business name is required" };
  if (keywords.length === 0) return { ok: false, error: "Add at least one keyword" };
  if (keywords.length > 10) return { ok: false, error: "Ten keywords maximum" };
  if (!SIZES.has(gridSize)) return { ok: false, error: "Grid size must be 3, 5, 7 or 9" };
  if (!Number.isFinite(spacing) || spacing < 100 || spacing > 20_000) {
    return { ok: false, error: "Spacing must be between 100 and 20000 metres" };
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { ok: false, error: "Latitude must be between -90 and 90" };
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { ok: false, error: "Longitude must be between -180 and 180" };
  }
  if (provider !== "stub" && provider !== "n8n") return { ok: false, error: "Unknown provider" };

  return {
    ok: true,
    value: {
      business_name: businessName,
      place_ref: placeRef || null,
      keywords,
      grid_size: gridSize,
      spacing_m: Math.round(spacing),
      center_lat: lat,
      center_lng: lng,
      provider,
    },
  };
}
