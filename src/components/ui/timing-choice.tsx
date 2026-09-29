"use client";

import type { Timing } from "@/services/maintenance/schedule";

/**
 * "Run now" vs "In the maintenance window", inside a confirmation dialog.
 *
 * Uncontrolled by default: radios named `timing` inside the dialog are part
 * of the surrounding <form> (the <dialog> is a DOM descendant of it), so the
 * choice arrives in the server action's FormData with no extra wiring. Pass
 * `value`/`onChange` where the dialog is not inside a form.
 *
 * Each option is a full-width, 44px-tall label on touch devices so it can be
 * hit with a thumb on a phone.
 */
/** The hint under "In this site's maintenance window" for one site. */
export function windowHint(nextWindow: string | null): string {
  return nextWindow === "Open now"
    ? "The window is open right now, so this runs now either way."
    : `Next window: ${nextWindow}.`;
}

export function TimingChoice({
  windowLabel, windowHint, value, onChange,
}: {
  windowLabel: string;
  windowHint: string;
  value?: Timing;
  onChange?: (t: Timing) => void;
}) {
  const controlled = value !== undefined;
  const option = (t: Timing, title: string, hint: string) => (
    <label
      className="flex min-h-10 cursor-pointer items-start gap-3 rounded-2xl border border-hairline px-4 py-3
        transition-colors duration-150 hover:bg-canvas has-[:checked]:border-ink pointer-coarse:min-h-11"
    >
      <input
        type="radio"
        name="timing"
        value={t}
        {...(controlled
          ? { checked: value === t, onChange: () => onChange?.(t) }
          : { defaultChecked: t === "now" })}
        className="mt-1 size-4 shrink-0 accent-ink"
      />
      <span className="min-w-0">
        <span className="block text-body font-medium text-ink">{title}</span>
        <span className="block text-caption tracking-normal text-mid-gray">{hint}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-body font-medium text-ink">When should this run?</legend>
      {option("now", "Run now", "Queued now; starts within a minute or so.")}
      {option("window", windowLabel, windowHint)}
    </fieldset>
  );
}
