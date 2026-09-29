"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { setMaintenanceWindowAction } from "./maintenance-actions";
import { buttonClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";
import { StatusBadge } from "@/components/ui/primitives";
import { DEFAULT_TIMEZONE, WEEKDAY_SHORT, type MaintenanceWindow } from "@/services/maintenance/window";

const DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 180, label: "3 hours" },
  { minutes: 240, label: "4 hours" },
  { minutes: 360, label: "6 hours" },
  { minutes: 480, label: "8 hours" },
  { minutes: 720, label: "12 hours" },
];

/** Monday-first, which is how people read a week; values stay 0 = Sunday. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function SaveButton({ label, variant = "outline" }: { label: string; variant?: "outline" | "ghost" }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass(variant, "sm")}>
      {pending && <IconSpinner size={14} />}
      {pending ? "Saving…" : label}
    </button>
  );
}

/**
 * The site's maintenance window (0027_site_maintenance_window.sql): when bulk
 * and fleet updates may run if queued "in each site's maintenance window".
 *
 * `summary` and `next` are computed on the server, in the window's own zone,
 * so what is shown is exactly what the scheduler will use. `canEdit` mirrors
 * setMaintenanceWindowAction's gate (sites.manage + a manage grant).
 */
export function MaintenanceWindowForm({
  siteId, window, summary, next, canEdit,
}: {
  siteId: string;
  window: MaintenanceWindow | null;
  summary: string | null;
  next: string | null;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(setMaintenanceWindowAction.bind(null, siteId), null);
  // The runtime's own zone list, for suggestions only; the server validates.
  const zones = useMemo(() => {
    try {
      return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    } catch {
      return [];
    }
  }, []);
  const durations = window && !DURATIONS.some((d) => d.minutes === window.durationMinutes)
    ? [...DURATIONS, { minutes: window.durationMinutes, label: `${window.durationMinutes} minutes` }]
    : DURATIONS;

  return (
    <div className="border-t border-hairline px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body text-mid-gray">Maintenance window</p>
            {window ? <StatusBadge tone="good">Set</StatusBadge> : <StatusBadge tone="idle">None</StatusBadge>}
          </div>
          <p className="break-words text-body text-ink">{summary ?? "Bulk updates always run when queued."}</p>
          {next && (
            <p className="text-caption tracking-normal text-mid-gray">Next window: {next}</p>
          )}
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={buttonClass("ghost", "sm")}
            aria-expanded={open}
          >
            {open ? "Close" : window ? "Change" : "Set up"}
          </button>
        )}
      </div>

      {canEdit && open && (
        <div className="mt-3 space-y-3">
          <form action={formAction} className="space-y-3">
            <fieldset>
              <legend className={labelClass}>Days</legend>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {DAY_ORDER.map((d) => (
                  <label
                    key={d}
                    className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-2xl border
                      border-hairline px-3 text-body text-ink transition-colors duration-150 hover:bg-canvas
                      has-[:checked]:border-ink has-[:checked]:bg-canvas pointer-coarse:min-h-11"
                  >
                    <input
                      type="checkbox"
                      name="days"
                      value={d}
                      defaultChecked={window?.days.includes(d) ?? false}
                      className="size-4 accent-ink"
                    />
                    {WEEKDAY_SHORT[d]}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <label htmlFor="mw_start" className={labelClass}>Starts at</label>
                <input
                  id="mw_start"
                  name="start"
                  type="time"
                  required
                  defaultValue={window?.start ?? "01:00"}
                  className={inputClass}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="mw_duration" className={labelClass}>Lasts</label>
                <select
                  id="mw_duration"
                  name="duration"
                  defaultValue={String(window?.durationMinutes ?? 120)}
                  className={inputClass}
                >
                  {durations.map((d) => (
                    <option key={d.minutes} value={d.minutes}>{d.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="mw_timezone" className={labelClass}>Time zone</label>
                <input
                  id="mw_timezone"
                  name="timezone"
                  list="mw_timezones"
                  required
                  spellCheck={false}
                  defaultValue={window?.timeZone ?? DEFAULT_TIMEZONE}
                  className={inputClass}
                />
                <datalist id="mw_timezones">
                  {zones.map((z) => <option key={z} value={z} />)}
                </datalist>
              </div>
            </div>

            <p className="text-caption tracking-normal text-mid-gray">
              Times are in the site’s time zone, not yours. Updates queued “in each site’s
              maintenance window” wait until the next window opens; if it is open already they
              start straight away. Nothing is queued by setting this.
            </p>

            {state && !state.ok && (
              <p aria-live="polite" className="flex items-start gap-2 text-body text-ember">
                <IconAlert size={16} className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">{state.error}</span>
              </p>
            )}
            {state?.ok && <p aria-live="polite" className="text-body text-status-good">Saved.</p>}

            <SaveButton label="Save window" />
          </form>

          {window && (
            // No days = no window (parseWindowForm), so an empty form clears it.
            <form action={formAction}>
              <SaveButton label="Remove window" variant="ghost" />
            </form>
          )}
        </div>
      )}
    </div>
  );
}
