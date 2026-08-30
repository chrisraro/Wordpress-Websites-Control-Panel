"use client";

import { useActionState, useEffect, useRef } from "react";
import { generateReportAction } from "../reports-actions";
import { useToast } from "@/components/ui/toast";
import { buttonClass, cardClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconReport, IconSpinner } from "@/components/ui/icons";

const SECTIONS = [
  { value: "security", label: "Security", hint: "Grade, vulnerabilities, hardening" },
  { value: "seo", label: "SEO & AEO", hint: "Audit score, keywords, AI visibility" },
  { value: "geogrid", label: "Local visibility", hint: "GeoGrid ranks and coverage" },
  { value: "inventory", label: "Site inventory", hint: "Core, plugins, themes" },
] as const;

export function GenerateReportForm({ siteId }: { siteId: string }) {
  const action = generateReportAction.bind(null, siteId);
  const [state, formAction, pending] = useActionState(action, null);
  const { toast } = useToast();
  const lastReported = useRef<typeof state>(null);

  useEffect(() => {
    if (!state || state === lastReported.current) return;
    lastReported.current = state;
    if (state.ok) {
      toast({
        tone: "success",
        title: "Report generated",
        description: "It is listed below with a share link ready to send.",
      });
    } else {
      toast({ tone: "error", title: "Report failed", description: state.error });
    }
  }, [state, toast]);

  return (
    <form action={formAction} className={`${cardClass} space-y-5 p-5`}>
      <fieldset>
        <legend className={`${labelClass} mb-2`}>Sections to include</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SECTIONS.map((s) => (
            <label
              key={s.value}
              className="flex min-h-10 pointer-coarse:min-h-11 cursor-pointer items-start gap-3 rounded-2xl px-3 py-2
                transition-colors duration-150 hover:bg-canvas"
            >
              <input
                type="checkbox"
                name="sections"
                value={s.value}
                defaultChecked
                className="mt-0.5 size-4 shrink-0 rounded-md accent-ink"
              />
              <span className="min-w-0">
                <span className="block text-body text-ink">{s.label}</span>
                <span className="block text-caption tracking-normal text-mid-gray">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5 sm:max-w-64">
        <label htmlFor="period_days" className={labelClass}>
          Reporting period
        </label>
        <select id="period_days" name="period_days" defaultValue="30" className={inputClass}>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending} className={buttonClass("primary")}>
          {pending ? <IconSpinner size={16} /> : <IconReport size={16} />}
          {pending ? "Generating…" : "Generate report"}
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
