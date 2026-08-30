"use client";

import { useFormStatus } from "react-dom";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./styles";
import { IconSpinner } from "./icons";

/**
 * A submit button for a plain `<form>` whose pending state cannot be lifted
 * into the page itself — the page stays a Server Component (see
 * `ManageForm` in sites/[id]/action-form.tsx for the equivalent when a
 * client-owned `useActionState` is already in play). `useFormStatus` reads
 * the nearest parent `<form>`'s pending state, which only works because
 * this button is its own component rendered *inside* that form — calling
 * the hook from the same component that renders the `<form>` tag returns
 * nothing, by React's own design.
 *
 * Matches ManageForm's vocabulary on purpose: a spinner plus a label swap
 * ("Searching…", not just a spinner) with the same default of "Working…",
 * disabled during the request, and `aria-busy` so the pending state reaches
 * assistive tech too, not only sighted users.
 */
export function SubmitButton({
  label, pendingLabel, icon, variant = "primary", size = "md", className,
}: {
  label: string;
  pendingLabel?: string;
  icon?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const { pending } = useFormStatus();
  const busyLabel = pendingLabel ?? "Working…";

  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={className ?? buttonClass(variant, size)}
    >
      {pending ? <IconSpinner size={size === "sm" ? 14 : 16} /> : icon}
      {pending ? busyLabel : label}
    </button>
  );
}
