"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { IconAlert, IconCheck, IconClose, IconInfo } from "./icons";

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

/** Errors stay long enough to read a plugin name and a reason. */
const LIFETIME: Record<ToastTone, number> = {
  success: 4500,
  info: 5000,
  error: 9000,
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
      setToasts((list) => [...list.slice(-3), { ...input, id, tone }]);
      const timer = setTimeout(() => remove(id), LIFETIME[tone]);
      timers.current.set(id, timer);
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
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center
          gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const Mark = TONE_ICON[t.tone];
          return (
            <div
              key={t.id}
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
                className="-m-1 shrink-0 rounded-2xl p-1 text-mid-gray transition-colors
                  hover:bg-canvas hover:text-ink"
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
