"use client";

import { useActionState } from "react";
import { generateReportAction } from "../reports-actions";

const SECTIONS = [
  { value: "security", label: "Security" },
  { value: "seo", label: "SEO & AEO" },
  { value: "geogrid", label: "Local visibility (GeoGrid)" },
  { value: "inventory", label: "Site inventory" },
] as const;

export function GenerateReportForm({ siteId }: { siteId: string }) {
  const action = generateReportAction.bind(null, siteId);
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="space-y-4 rounded-lg border bg-white p-4 shadow-sm">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Sections to include</legend>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {SECTIONS.map((s) => (
            <label key={s.value} className="flex min-h-10 items-center gap-2 text-sm">
              <input type="checkbox" name="sections" value={s.value} defaultChecked />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block text-sm font-medium sm:max-w-56">
        Reporting period
        <select name="period_days" defaultValue="30" className="min-h-10 w-full rounded border px-3 py-2">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending}
          className="min-h-10 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
          {pending ? "Generating…" : "Generate report"}
        </button>
        <p aria-live="polite" className="text-sm">
          {state && !state.ok && <span className="text-red-600">{state.error}</span>}
          {state?.ok && <span className="text-green-700">Report generated.</span>}
        </p>
      </div>
    </form>
  );
}
