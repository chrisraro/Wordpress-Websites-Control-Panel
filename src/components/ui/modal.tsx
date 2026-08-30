"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { buttonClass, iconButtonClass } from "./styles";
import { IconClose } from "./icons";

/**
 * Built on the native <dialog> element via showModal(), which gives us the
 * focus trap, Escape handling, background inertness, and top-layer rendering
 * for free — and, crucially, escapes any `overflow-hidden` ancestor, which a
 * hand-rolled absolutely-positioned overlay does not.
 */
export function Modal({
  open, onClose, title, description, children, footer, size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        // Let React own the open state rather than the DOM closing behind it.
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-0 h-full max-h-full w-full max-w-full overflow-y-auto bg-transparent"
    >
      <div
        className="animate-backdrop fixed inset-0 bg-ink/25"
        onClick={onClose}
        aria-hidden
      />
      {/* Sheet on phones, centred card from sm up. */}
      <div className="relative flex min-h-full items-end justify-center p-4 sm:items-center">
        <div
          className={`animate-overlay w-full ${size === "lg" ? "max-w-2xl" : "max-w-md"}
            rounded-3xl border border-hairline bg-paper shadow-overlay`}
        >
          <div className="flex items-start justify-between gap-4 p-5 pb-0">
            <h2 id={titleId} className="text-subheading font-semibold text-ink">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className={iconButtonClass("-m-1.5 shrink-0")}
            >
              <IconClose size={18} />
            </button>
          </div>
          {description && (
            <div id={descId} className="px-5 pt-2 text-body text-mid-gray">
              {description}
            </div>
          )}
          {children && (
            <div className={`px-5 pt-4 ${footer ? "" : "pb-5"}`}>{children}</div>
          )}
          {footer && (
            <div className="flex flex-col-reverse gap-2 p-5 sm:flex-row sm:justify-end">
              {footer}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}

/**
 * Confirmation for an action that is consequential or hard to undo. Benign,
 * repeatable actions (refresh, drain the queue) deliberately do NOT get one —
 * an interruption that carries no decision is just friction.
 */
export function ConfirmDialog({
  open, title, description, confirmLabel = "Confirm", tone = "default", onConfirm, onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      footer={
        <>
          <button type="button" onClick={onCancel} className={buttonClass("secondary")}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            // Destructive confirmations do not steal focus: the safe path
            // should be what Enter reaches first.
            autoFocus={tone !== "danger"}
            className={buttonClass(tone === "danger" ? "danger" : "primary")}
          >
            {confirmLabel}
          </button>
        </>
      }
    />
  );
}
