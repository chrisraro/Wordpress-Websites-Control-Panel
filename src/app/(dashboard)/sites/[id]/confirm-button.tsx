"use client";

import { useFormStatus } from "react-dom";

export function ConfirmButton({
  label, pendingLabel, confirmMessage, className,
}: {
  label: string; pendingLabel?: string; confirmMessage: string; className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className={`min-h-10 ${className ?? "rounded border px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"}`}
      onClick={(e) => {
        if (!window.confirm(confirmMessage)) e.preventDefault();
      }}>
      {pending ? (pendingLabel ?? "Working…") : label}
    </button>
  );
}
