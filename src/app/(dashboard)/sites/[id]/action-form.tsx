"use client";

import { useActionState } from "react";

export type ManageResult = { ok: boolean; error?: string } | null;
export type ManageFormAction = (prevState: ManageResult, formData: FormData) => Promise<ManageResult>;

/**
 * Form wrapper for a bound server action: confirm dialog, pending state, and
 * inline error surfacing (failures were previously discarded silently).
 */
export function ManageForm({
  action, label, pendingLabel, confirmMessage, className, buttonClassName,
}: {
  action: ManageFormAction;
  label: string;
  pendingLabel?: string;
  confirmMessage: string;
  className?: string;
  buttonClassName?: string;
}) {
  const [state, formAction, pending] = useActionState<ManageResult, FormData>(action, null);
  return (
    <form action={formAction} className={className}>
      <button
        type="submit"
        disabled={pending}
        className={`min-h-10 ${buttonClassName ?? "rounded border px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"}`}
        onClick={(e) => {
          if (!window.confirm(confirmMessage)) e.preventDefault();
        }}>
        {pending ? (pendingLabel ?? "Working…") : label}
      </button>
      {state && !state.ok && (
        <p role="alert" className="mt-1 max-w-64 text-xs text-red-600">
          {state.error ?? "Action failed"}
        </p>
      )}
    </form>
  );
}
