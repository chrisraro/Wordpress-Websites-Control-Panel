"use client";

/**
 * Reusable row-selection primitives for tables that support bulk actions
 * (plugins, themes). `useSelection` owns the Set of selected ids; the three
 * components below are pure presentation over it, so a table only wires up
 * `onChange` handlers and never touches selection state directly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonClass } from "./styles";

export function useSelection(allIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Ids can disappear when the inventory refreshes; a selection referring to a
  // deleted plugin would enqueue a job for something that no longer exists.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => allIds.includes(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [allIds]);

  // Callers pass `allIds` as an inline expression (e.g. `plugins.map(p => p.file)`),
  // so it is a brand-new array identity on every parent render even when its
  // contents haven't changed. Track the latest value in a ref -- updated here
  // during render, not in an effect, so it's current the instant a handler
  // reads it -- so `toggleAll` doesn't need `allIds` in a dependency array.
  // That's what keeps toggle/toggleAll/clear stable across parent re-renders,
  // which matters because row components are memoised against them.
  const allIdsRef = useRef(allIds);
  allIdsRef.current = allIds;

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const ids = allIdsRef.current;
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(ids);
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const isSelected = (id: string) => selected.has(id);

  // Checked by membership, not by comparing sizes. `allIds` is a fresh array
  // every parent render, but `selected` is only pruned of vanished ids by the
  // effect above, which runs after paint. That leaves a reachable render
  // where `selected` still holds the OLD ids while `allIds` already holds a
  // NEW set of the same length -- a same-size mismatch. Comparing set sizes
  // would misreport allChecked/someChecked in that window, and worse, would
  // make a "select all" click take the old `prev.size === allIds.length`
  // branch and CLEAR the selection instead of selecting the visible rows.
  // Checking membership directly is correct in that window too, since it
  // never depends on the prune effect having already run.
  const allChecked = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someChecked = !allChecked && allIds.some((id) => selected.has(id));

  return {
    selected: [...selected],
    isSelected,
    toggle,
    toggleAll,
    clear,
    allChecked,
    someChecked,
  };
}

export function SelectAllCheckbox({
  allChecked,
  someChecked,
  onChange,
  label = "Select all rows",
}: {
  allChecked: boolean;
  someChecked: boolean;
  onChange: () => void;
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // There is no `indeterminate` HTML attribute — only the DOM property — so a
  // partial selection can only be reflected through a ref effect. Skipping
  // this silently leaves the header checkbox showing "nothing selected"
  // whenever some (but not all) rows are checked.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someChecked;
  }, [someChecked]);

  return (
    // The label wrapper — not the 16px input — is the tap target. 40px is
    // not the floor: WCAG 2.5.5, Apple HIG and Material all land at 44-48px,
    // and these sit in the bulk-action tables, which is maintenance work done
    // on a phone. pointer-coarse raises them for touch without inflating the
    // compact table rhythm under a mouse (see BUTTON_SIZE in ui/styles.ts).
    <label className="flex min-h-10 w-10 cursor-pointer items-center justify-center pointer-coarse:min-h-11 pointer-coarse:w-11">
      <input
        ref={ref}
        type="checkbox"
        checked={allChecked}
        onChange={onChange}
        aria-label={label}
        className="size-4 shrink-0 rounded-md accent-ink"
      />
    </label>
  );
}

export function RowCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex min-h-10 w-10 cursor-pointer items-center justify-center pointer-coarse:min-h-11 pointer-coarse:w-11">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        // Naming the row's item, so a screen reader announces what is being
        // selected rather than "checkbox, checkbox, checkbox".
        aria-label={`Select ${label}`}
        className="size-4 shrink-0 rounded-md accent-ink"
      />
    </label>
  );
}

export interface BulkAction {
  key: string;
  label: string;
  tone?: "default" | "danger";
  onClick: () => void;
  disabled?: boolean;
  /** Shown via `title` on hover and via `aria-describedby` to screen readers. */
  disabledReason?: string;
}

export function BulkBar({
  count,
  actions,
  onClear,
}: {
  count: number;
  actions: BulkAction[];
  onClear: () => void;
}) {
  if (count === 0) return null;

  return (
    // Sticky, not fixed: the toast region is bottom-right from `sm` up and
    // top-anchored below it (see toast.tsx), so the two never overlap, and a
    // fixed bar would sit on top of the notification confirming the action.
    <div
      className="sticky bottom-0 z-20 mt-4 flex flex-col gap-3 rounded-3xl border border-hairline
        bg-paper p-4 shadow-raised sm:flex-row sm:items-center sm:justify-between"
      role="region"
      aria-label="Bulk actions"
    >
      <p className="text-body text-ink" aria-live="polite">
        {count} selected
      </p>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => {
          // aria-describedby (rather than folding the reason into aria-label)
          // keeps the button's accessible name as its visible label while
          // still surfacing *why* it's disabled to assistive tech — matching
          // what `title` already does for sighted mouse users on hover.
          const reasonId = a.disabled && a.disabledReason ? `bulk-action-reason-${a.key}` : undefined;
          return (
            <span key={a.key} className="inline-flex flex-col">
              {/* aria-disabled, not the `disabled` attribute: a disabled
                  button is removed from the tab order entirely, so a keyboard
                  or screen-reader user never landed on it and never heard the
                  aria-describedby reason this component builds for them. The
                  `title` fallback is mouse-hover only, so the explanation
                  reached everyone except the people it was written for. The
                  click handler is gated instead. */}
              <button
                type="button"
                onClick={a.disabled ? undefined : a.onClick}
                aria-disabled={a.disabled || undefined}
                title={a.disabled ? a.disabledReason : undefined}
                aria-describedby={reasonId}
                className={buttonClass(
                  a.tone === "danger" ? "danger" : "outline",
                  "md",
                  a.disabled ? "cursor-not-allowed opacity-50" : undefined,
                )}
              >
                {a.label}
              </button>
              {reasonId && (
                <span id={reasonId} className="sr-only">
                  {a.disabledReason}
                </span>
              )}
            </span>
          );
        })}
        <button type="button" onClick={onClear} className={buttonClass("ghost", "md")}>
          Clear
        </button>
      </div>
    </div>
  );
}
