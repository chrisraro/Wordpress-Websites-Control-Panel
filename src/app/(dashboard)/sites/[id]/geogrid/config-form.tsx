"use client";

import { useActionState } from "react";
import { saveGeoGridConfigAction } from "../geogrid-actions";
import type { GeoGridConfig } from "@/services/geogrid/types";

const field = "min-h-10 w-full rounded border px-3 py-2";

export function GeoGridConfigForm({
  siteId, config,
}: { siteId: string; config: GeoGridConfig | null }) {
  const action = saveGeoGridConfigAction.bind(null, siteId) as unknown as (
    prev: { ok: boolean; error?: string } | null, formData: FormData,
  ) => Promise<{ ok: boolean; error?: string }>;
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="space-y-4 rounded-lg border bg-white p-4 shadow-sm">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Business name
          <input name="business_name" required defaultValue={config?.business_name ?? ""}
            placeholder="Test Cafe" className={field} />
        </label>
        <label className="block text-sm font-medium">
          Place reference (optional)
          <input name="place_ref" defaultValue={config?.place_ref ?? ""}
            placeholder="Google place id or listing URL" className={field} />
        </label>
      </div>

      <label className="block text-sm font-medium">
        Keywords (comma separated, up to 10)
        <input name="keywords" required defaultValue={config?.keywords.join(", ") ?? ""}
          placeholder="coffee shop, espresso bar" className={field} />
      </label>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <label className="block text-sm font-medium">
          Grid size
          <select name="grid_size" defaultValue={String(config?.grid_size ?? 5)} className={field}>
            {[3, 5, 7, 9].map((n) => <option key={n} value={n}>{n} × {n}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Spacing (m)
          <input name="spacing_m" type="number" min={100} max={20000} step={100}
            defaultValue={config?.spacing_m ?? 1000} className={field} />
        </label>
        <label className="block text-sm font-medium">
          Centre latitude
          <input name="center_lat" type="number" step="any" required
            defaultValue={config?.center_lat ?? ""} placeholder="14.5995" className={field} />
        </label>
        <label className="block text-sm font-medium">
          Centre longitude
          <input name="center_lng" type="number" step="any" required
            defaultValue={config?.center_lng ?? ""} placeholder="120.9842" className={field} />
        </label>
      </div>

      <label className="block text-sm font-medium sm:max-w-64">
        Rank provider
        <select name="provider" defaultValue={config?.provider ?? "stub"} className={field}>
          <option value="stub">Stub (sample data, no API cost)</option>
          <option value="n8n">n8n workflow (live ranks)</option>
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending}
          className="min-h-10 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
          {pending ? "Saving…" : config ? "Update configuration" : "Save configuration"}
        </button>
        <p aria-live="polite" className="text-sm">
          {state && !state.ok && <span className="text-red-600">{state.error}</span>}
          {state?.ok && <span className="text-green-700">Saved.</span>}
        </p>
      </div>
    </form>
  );
}
