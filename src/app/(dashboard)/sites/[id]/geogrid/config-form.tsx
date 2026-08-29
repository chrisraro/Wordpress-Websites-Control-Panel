"use client";

import { useActionState, useEffect, useRef } from "react";
import { saveGeoGridConfigAction } from "../geogrid-actions";
import type { GeoGridConfig } from "@/services/geogrid/types";
import { useToast } from "@/components/ui/toast";
import { buttonClass, cardClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";

export function GeoGridConfigForm({
  siteId, config,
}: { siteId: string; config: GeoGridConfig | null }) {
  // No cast: the bound action's signature already matches what useActionState
  // passes, (prevState, formData) — a mismatch here is a runtime crash.
  const action = saveGeoGridConfigAction.bind(null, siteId);
  const [state, formAction, pending] = useActionState(action, null);
  const { toast } = useToast();
  const lastReported = useRef<typeof state>(null);

  useEffect(() => {
    if (!state || state === lastReported.current) return;
    lastReported.current = state;
    if (state.ok) {
      toast({ tone: "success", title: config ? "Configuration updated" : "Configuration saved" });
    } else {
      toast({ tone: "error", title: "Could not save", description: state.error });
    }
  }, [state, config, toast]);

  return (
    <form action={formAction} className={`${cardClass} space-y-5 p-5`}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="business_name" className={labelClass}>
            Business name
          </label>
          <input
            id="business_name"
            name="business_name"
            required
            defaultValue={config?.business_name ?? ""}
            placeholder="Test Cafe"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="place_ref" className={labelClass}>
            Place reference <span className="font-normal text-mid-gray">(optional)</span>
          </label>
          <input
            id="place_ref"
            name="place_ref"
            defaultValue={config?.place_ref ?? ""}
            placeholder="Google place ID or listing URL"
            className={inputClass}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="keywords" className={labelClass}>
          Keywords
        </label>
        <input
          id="keywords"
          name="keywords"
          required
          defaultValue={config?.keywords.join(", ") ?? ""}
          placeholder="coffee shop, espresso bar"
          aria-describedby="keywords-hint"
          className={inputClass}
        />
        <p id="keywords-hint" className={hintClass}>
          Comma separated, up to 10. Each keyword is measured across the whole grid as its own run.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <label htmlFor="grid_size" className={labelClass}>
            Grid size
          </label>
          <select
            id="grid_size"
            name="grid_size"
            defaultValue={String(config?.grid_size ?? 5)}
            className={inputClass}
          >
            {[3, 5, 7, 9].map((n) => (
              <option key={n} value={n}>
                {n} × {n} ({n * n} points)
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="spacing_m" className={labelClass}>
            Spacing (metres)
          </label>
          <input
            id="spacing_m"
            name="spacing_m"
            type="number"
            min={100}
            max={20000}
            step={100}
            defaultValue={config?.spacing_m ?? 1000}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="center_lat" className={labelClass}>
            Centre latitude
          </label>
          <input
            id="center_lat"
            name="center_lat"
            type="number"
            step="any"
            required
            defaultValue={config?.center_lat ?? ""}
            placeholder="14.5995"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="center_lng" className={labelClass}>
            Centre longitude
          </label>
          <input
            id="center_lng"
            name="center_lng"
            type="number"
            step="any"
            required
            defaultValue={config?.center_lng ?? ""}
            placeholder="120.9842"
            className={inputClass}
          />
        </div>
      </div>

      <div className="space-y-1.5 sm:max-w-72">
        <label htmlFor="provider" className={labelClass}>
          Rank provider
        </label>
        <select
          id="provider"
          name="provider"
          defaultValue={config?.provider ?? "stub"}
          className={inputClass}
        >
          <option value="stub">Stub — sample data, no API cost</option>
          <option value="n8n">n8n workflow — live ranks</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending} className={buttonClass("primary")}>
          {pending && <IconSpinner size={16} />}
          {pending ? "Saving…" : config ? "Update configuration" : "Save configuration"}
        </button>
        {state && !state.ok && (
          <p aria-live="off" className="flex items-center gap-2 text-body text-ember">
            <IconAlert size={16} className="shrink-0" />
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
