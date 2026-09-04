"use client";

import { useLinkStatus } from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { IconSpinner } from "@/components/ui/icons";

/**
 * Feedback for the gap between clicking a link and the next page appearing.
 *
 * Every page under this layout is `force-dynamic`, and the dashboard alone
 * spends most of a second in Supabase before it can render (measured: ~620ms
 * for the site list, ~440ms for the per-site reads). Next renders the route's
 * `loading.tsx` as soon as it can, but it cannot do that until the route's
 * chunk has arrived — and until then the *old* page stays on screen,
 * completely unchanged. A click therefore looks exactly like a click that
 * missed, which is why the reported symptom was "you have to click the button
 * again": people were not describing a broken link, they were describing an
 * interface that never admitted it had heard them.
 *
 * So the fix is not a faster page, it is an immediate answer. `useLinkStatus`
 * (Next 15.3+) reports the pending state of the navigation its parent `Link`
 * started, which is available in the same tick as the click — before any
 * network work finishes.
 *
 * The store is module-level rather than a context: a beacon must be cheap
 * enough to drop inside every link on the page without threading a provider
 * through server components, and the only shared state is a single integer.
 */

let pending = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = () => pending;
// The server has no navigation in flight, and returning a constant keeps
// useSyncExternalStore from tearing during hydration.
const getServerSnapshot = () => 0;

/**
 * Drop inside a `<Link>` to report its navigation to the bar.
 *
 * Renders nothing by default. `spinner` shows a spinner while the navigation
 * is in flight, for links whose own affordance should visibly respond — a
 * sidebar item you just clicked should not look identical to the two below it.
 *
 * `children` are what stands there the rest of the time, which makes this a
 * swap rather than an addition: a row that already ends in a chevron should
 * turn that chevron into the spinner, not grow a second glyph and reflow the
 * row at the exact moment the user is trying to read it.
 */
export function LinkPending({
  spinner = false, children,
}: { spinner?: boolean; children?: ReactNode }) {
  const { pending: isPending } = useLinkStatus();

  useEffect(() => {
    if (!isPending) return;
    pending += 1;
    emit();
    return () => {
      pending -= 1;
      emit();
    };
  }, [isPending]);

  if (isPending && spinner) {
    return <IconSpinner size={16} className="shrink-0 text-mid-gray" aria-hidden />;
  }
  return <>{children ?? null}</>;
}

/**
 * The bar itself. One per layout.
 *
 * It deliberately does not model real progress, because there is none to
 * model: the server gives no byte-count to track, and a bar that pretends
 * otherwise is lying at a moment when the user is already unsure whether
 * anything is happening. It eases toward 90% and waits there, then completes
 * only when the navigation actually does — the honest shape of "working on
 * it, nearly there, not finished".
 */
export function NavProgressBar() {
  const count = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);

    if (count > 0) {
      setPhase("running");
      return;
    }
    // Only "finish" a bar that was actually started; a stray zero on mount
    // must not flash a completed bar at someone who has not clicked anything.
    setPhase((p) => (p === "running" ? "done" : "idle"));
    // Long enough for the 100% fill and fade to be seen as completion rather
    // than as a glitch, short enough not to overlap the next navigation.
    timer.current = setTimeout(() => setPhase("idle"), 320);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [count]);

  return (
    <div
      // Not a progress role: this is decoration for a wait the page already
      // announces elsewhere, and an assertive live region firing on every
      // navigation would be far worse than silence for a screen reader user.
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
    >
      {/* Always mounted, never conditionally rendered. A CSS width transition
          needs a previous value to move from, so a bar that only appears once
          it is already at 90% does not animate -- it just materialises there,
          which reads as a glitch rather than as progress. Staying mounted at
          zero width costs one empty div and makes the motion real. */}
      <div
        className={`h-full bg-ink ${
          phase === "idle"
            ? "w-0 opacity-0 duration-0"
            : phase === "done"
              ? "w-full opacity-0 duration-300"
              : "w-[90%] opacity-100 duration-[2000ms] motion-reduce:duration-150"
        } transition-[width,opacity] ease-out`}
      />
    </div>
  );
}
