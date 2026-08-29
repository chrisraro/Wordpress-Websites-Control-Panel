"use client";

/**
 * Reusable row-selection primitives for tables that support bulk actions
 * (plugins, themes). `useSelection` owns the Set of selected ids; the three
 * components below are pure presentation over it, so a table only wires up
 * `onChange` handlers and never touches selection state directly.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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

  return useMemo(() => {
    const isSelected = (id: string) => selected.has(id);
    const toggle = (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    const toggleAll = () =>
      setSelected((prev) => (prev.size === allIds.length ? new Set() : new Set(allIds)));
    return {
      selected: [...selected],
      isSelected,
      toggle,
      toggleAll,
      clear: () => setSelected(new Set()),
      allChecked: allIds.length > 0 && selected.size === allIds.length,
      someChecked: selected.size > 0 && selected.size < allIds.length,
    };
  }, [selected, allIds]);
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
    // The label wrapper — not the 16px input — is what meets the 40px touch
    // target floor; the same pattern already used for checkboxes elsewhere
    // in this codebase (upload-card.tsx, install-panel.tsx).
    <label className="flex min-h-10 w-10 cursor-pointer items-center justify-center">
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
    <label className="flex min-h-10 w-10 cursor-pointer items-center justify-center">
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
    // Sticky, not fixed: the toast region is fixed at bottom-right, and a
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
              <button
                type="button"
                onClick={a.onClick}
                disabled={a.disabled}
                title={a.disabled ? a.disabledReason : undefined}
                aria-describedby={reasonId}
                className={buttonClass(a.tone === "danger" ? "danger" : "outline", "md")}
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
