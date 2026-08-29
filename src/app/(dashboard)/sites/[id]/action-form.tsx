"use client";

import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { buttonClass, type ButtonSize, type ButtonVariant } from "@/components/ui/styles";
import { IconSpinner } from "@/components/ui/icons";

export type ManageResult = {
  ok: boolean;
  error?: string;
  /**
   * Overrides the success toast's title with the actual outcome (e.g. "Queued
   * inventory refresh for 8 sites") rather than the static `success` label,
   * for actions whose result isn't known until the server runs — most
   * actions don't set this and keep using `success`/`label`.
   */
  message?: string;
} | null;
export type ManageFormAction = (prevState: ManageResult, formData: FormData) => Promise<ManageResult>;

export interface ConfirmSpec {
  title: string;
  description: string;
  confirmLabel?: string;
  tone?: "default" | "danger";
}

/**
 * One control for every server action on a site: press feedback, a pending
 * state, an optional confirmation dialog, and a toast for the outcome.
 *
 * `confirm` is deliberately optional. Actions that are consequential or hard
 * to undo (updating core, deactivating a plugin, revoking a share link) get a
 * dialog; benign, repeatable ones (refresh inventory, drain the queue) do not,
 * because a prompt that carries no decision is friction, not safety.
 */
export function ManageForm({
  action, label, pendingLabel, confirm, success, variant = "outline", size = "md",
  icon, className, buttonClassName, showInlineError = true,
}: {
  action: ManageFormAction;
  label: string;
  pendingLabel?: string;
  confirm?: ConfirmSpec;
  /** Toast title on success. Defaults to the button's own label. */
  success?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  className?: string;
  buttonClassName?: string;
  showInlineError?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ManageResult, FormData>(action, null);
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const { toast } = useToast();
  // useActionState hands back a fresh object per run, so this fires once per
  // completed submission rather than once per render.
  const lastReported = useRef<ManageResult>(null);

  useEffect(() => {
    if (!state || state === lastReported.current) return;
    lastReported.current = state;
    if (state.ok) {
      toast({ tone: "success", title: state.message ?? success ?? label });
    } else {
      toast({
        tone: "error",
        title: `${label} failed`,
        description: state.error ?? "The site did not report a reason.",
      });
    }
  }, [state, label, success, toast]);

  const busyLabel = pendingLabel ?? "Working…";

  return (
    <form ref={formRef} action={formAction} className={className}>
      <button
        type={confirm ? "button" : "submit"}
        disabled={pending}
        onClick={confirm ? () => setOpen(true) : undefined}
        className={buttonClassName ?? buttonClass(variant, size)}
      >
        {pending ? <IconSpinner size={size === "sm" ? 14 : 16} /> : icon}
        {pending ? busyLabel : label}
      </button>

      {showInlineError && state && !state.ok && (
        // Persistent copy of the failure. aria-live is off because the toast
        // already announced it; this exists so the reason survives the toast.
        <p aria-live="off" className="mt-1.5 max-w-72 text-caption tracking-normal text-ember">
          {state.error ?? "Action failed"}
        </p>
      )}

      {confirm && (
        <ConfirmDialog
          open={open}
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel ?? label}
          tone={confirm.tone}
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            setOpen(false);
            formRef.current?.requestSubmit();
          }}
        />
      )}
    </form>
  );
}
