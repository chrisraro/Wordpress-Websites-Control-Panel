"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { IconAlert, IconCheck, IconClose, IconInfo } from "./icons";
import { iconButtonClass } from "./styles";

export type ToastTone = "success" | "error" | "info";

export interface ToastInput {
  title: string;
  /** Second line — the detail, the recovery, or what changed. */
  description?: string;
  tone?: ToastTone;
}

interface Toast extends ToastInput {
  id: number;
  tone: ToastTone;
  leaving?: boolean;
}

interface ToastApi {
  toast: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * How long a toast lingers. `null` means it never auto-dismisses.
 *
 * Errors are null on purpose. This product queues background work precisely
 * because it takes minutes, so the person who triggered an action is often
 * not watching when it fails -- the batch poller's own comment concedes "the
 * user may have looked away for minutes". A nine-second window was the wrong
 * unit for that: the failure announced itself once, removed itself from the
 * DOM, and left nothing behind. Errors now stay until dismissed.
 */
const LIFETIME: Record<ToastTone, number | null> = {
  success: 4500,
  info: 5000,
  error: null,
};

const EXIT_MS = 140;

const TONE_ICON: Record<ToastTone, typeof IconCheck> = {
  success: IconCheck,
  error: IconAlert,
  info: IconInfo,
};

/** The only colour in the toast is the mark; the card itself stays mono. */
const TONE_COLOR: Record<ToastTone, string> = {
  success: "text-status-good",
  error: "text-ember",
  info: "text-mid-gray",
};

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  // A no-op keeps a component usable outside the provider (tests, the public
  // share page) instead of crashing the tree over a notification.
  return ctx ?? { toast: () => {} };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    const timer = setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
      timers.current.delete(id);
    }, EXIT_MS);
    timers.current.set(id, timer);
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const tone = input.tone ?? "info";
      // Errors are never evicted by newer toasts either: a bulk failure can
      // emit several at once, and capping the list would drop the first
      // reasons on the floor while keeping the last.
      setToasts((list) => {
        const keep = list.filter((t) => t.tone === "error");
        const rest = list.filter((t) => t.tone !== "error").slice(-3);
        return [...keep, ...rest, { ...input, id, tone }];
      });
      const ttl = LIFETIME[tone];
      if (ttl !== null) {
        const timer = setTimeout(() => remove(id), ttl);
        timers.current.set(id, timer);
      }
    },
    [remove],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // Fixed, so a toast is never clipped by an overflow ancestor.
        // Top on a phone, bottom-right from `sm` up. It used to be
        // bottom-anchored and full-width at every size, which put it directly
        // over the sticky BulkBar -- so confirming a bulk update covered the
        // bulk bar with the toast confirming it. BulkBar's own comment
        // asserted "the toast region is fixed at bottom-right", which was
        // only true from `sm` up; this makes the two agree.
        className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center
          gap-2 p-4 sm:inset-x-auto sm:top-auto sm:bottom-0 sm:right-0 sm:items-end"
        role="status"
        aria-live="polite"
      >
        {/* Errors are announced assertively via a nested role="alert". A
            failed bulk delete announced `polite` waits behind whatever the
            reader is already saying, which on this surface is often the
            success toast for the items that did succeed. */}
        {toasts.map((t) => {
          const Mark = TONE_ICON[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === "error" ? "alert" : undefined}
              className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-3xl
                border border-hairline bg-paper p-4 shadow-overlay
                ${t.leaving ? "animate-toast-out" : "animate-toast-in"}`}
            >
              <Mark size={18} className={`mt-0.5 shrink-0 ${TONE_COLOR[t.tone]}`} />
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium text-ink">{t.title}</p>
                {t.description && (
                  <p className="mt-0.5 break-words text-caption tracking-normal text-mid-gray">
                    {t.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => remove(t.id)}
                aria-label="Dismiss notification"
                className={iconButtonClass("-m-1 shrink-0")}
              >
                <IconClose size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
