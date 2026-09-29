"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { setProductionPairAction } from "./pairing-actions";
import { buttonClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass("outline", "sm")}>
      {pending && <IconSpinner size={14} />}
      {pending ? "Saving…" : "Save pairing"}
    </button>
  );
}

/**
 * Sets or clears which production site this staging copy belongs to
 * (0026_site_production_pair.sql). Collapsed by default, like the origin
 * override beside it: it is set once and rarely touched.
 *
 * `options` is already narrowed server-side to production sites the viewer
 * can manage; the action re-checks both grants regardless.
 */
export function PairingForm({
  siteId, currentId, currentName, options,
}: {
  siteId: string;
  currentId: string | null;
  currentName: string | null;
  options: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(setProductionPairAction.bind(null, siteId), null);

  return (
    <div className="border-t border-hairline px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-body text-mid-gray">Production site</p>
          <p className="break-words text-body text-ink">{currentName ?? "Not paired"}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={buttonClass("ghost", "sm")}
          aria-expanded={open}
        >
          {open ? "Close" : currentId ? "Change" : "Pair"}
        </button>
      </div>

      {open && (
        <form action={formAction} className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="production_site_id" className={labelClass}>
              This staging site is a copy of
            </label>
            <select
              id="production_site_id"
              name="production_site_id"
              defaultValue={currentId ?? ""}
              className={inputClass}
              aria-describedby="production_site_id_hint"
            >
              <option value="">Not paired</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            <p id="production_site_id_hint" className="text-caption tracking-normal text-mid-gray">
              Only production sites you can manage are listed. The page then compares this copy’s
              WordPress, PHP, plugins and themes with that site’s latest inventory. Nothing on
              either site changes.
            </p>
          </div>

          {state && !state.ok && (
            <p aria-live="polite" className="flex items-start gap-2 text-body text-ember">
              <IconAlert size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{state.error}</span>
            </p>
          )}
          {state?.ok && (
            <p aria-live="polite" className="text-body text-status-good">Saved.</p>
          )}

          <SubmitButton />
        </form>
      )}
    </div>
  );
}
