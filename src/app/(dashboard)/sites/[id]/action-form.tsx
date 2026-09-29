"use client";

import { useEffect, useRef, useState } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { buttonClass, type ButtonSize, type ButtonVariant } from "@/components/ui/styles";
import { IconSpinner } from "@/components/ui/icons";
import { TimingChoice } from "@/components/ui/timing-choice";
import { BackupChoice } from "@/components/ui/backup-choice";

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
  /**
   * Where the real result of this action lives. Set by actions whose output
   * is a page rather than a sentence — queueing a batch produces a progress
   * view, and a toast saying "queued 8 sites" while leaving you on the
   * dashboard makes you go and find it. Navigation happens after the toast,
   * so the outcome is still announced.
   */
  href?: string;
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
  icon, className, buttonClassName, showInlineError = true, timingChoice, backupChoice,
  secondaryConfirm,
}: {
  action: ManageFormAction;
  label: string;
  pendingLabel?: string;
  confirm?: ConfirmSpec;
  /**
   * Offers "Run now" vs "In each site's maintenance window" inside the
   * confirmation, posted as the `timing` form field. Only meaningful with
   * `confirm`; omit it when no target site has a window.
   */
  timingChoice?: { windowLabel: string; windowHint: string };
  /**
   * Offers "Update without a backup" inside the confirmation, posted as the
   * `backup` form field (`skip` when ticked). For actions that queue updates;
   * only meaningful with `confirm`.
   */
  backupChoice?: boolean;
  /**
   * A second way to confirm, inside the same dialog, that submits the form
   * with one extra field (`name=value`) -- e.g. "Update core without a
   * backup" posting backup=skip. The field rides on a hidden submit button
   * used as the submitter, so the primary confirm never sends it.
   */
  secondaryConfirm?: { label: string; name: string; value: string };
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
  const secondaryRef = useRef<HTMLButtonElement>(null);
  const { toast } = useToast();
  const router = useRouter();
  // useActionState hands back a fresh object per run, so this fires once per
  // completed submission rather than once per render.
  const lastReported = useRef<ManageResult>(null);

  useEffect(() => {
    if (!state || state === lastReported.current) return;
    lastReported.current = state;
    if (state.ok) {
      toast({ tone: "success", title: state.message ?? success ?? label });
      if (state.href) router.push(state.href);
    } else {
      toast({
        tone: "error",
        title: `${label} failed`,
        description: state.error ?? "The site did not report a reason.",
      });
    }
  }, [state, label, success, toast, router]);

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
        <p aria-live="off" className="mt-1.5 max-w-72 break-words text-caption tracking-normal text-ember">
          {state.error ?? "Action failed"}
        </p>
      )}

      {secondaryConfirm && (
        // Never shown or focusable: it exists only to be the submitter that
        // carries the secondary choice's field into the FormData.
        <button
          ref={secondaryRef}
          type="submit"
          name={secondaryConfirm.name}
          value={secondaryConfirm.value}
          hidden
          tabIndex={-1}
          aria-hidden
        />
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
          secondary={secondaryConfirm && {
            label: secondaryConfirm.label,
            onClick: () => {
              setOpen(false);
              if (secondaryRef.current) formRef.current?.requestSubmit(secondaryRef.current);
            },
          }}
        >
          {(timingChoice || backupChoice) && (
            <div className="space-y-4">
              {timingChoice && (
                <TimingChoice windowLabel={timingChoice.windowLabel} windowHint={timingChoice.windowHint} />
              )}
              {backupChoice && <BackupChoice />}
            </div>
          )}
        </ConfirmDialog>
      )}
    </form>
  );
}
