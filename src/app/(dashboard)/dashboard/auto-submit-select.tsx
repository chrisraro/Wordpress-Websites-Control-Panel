"use client";

import { useRef, type ReactNode } from "react";

/**
 * A <select> inside the directory's plain GET form that applies itself.
 *
 * A mouse or touch pick applies at once. A keyboard is different: in Chrome,
 * arrowing through a closed select fires `change` on every option, so
 * applying on change would reload the page before the reader reached the
 * option they wanted (WCAG 3.2.2). Keyboard changes apply on Enter or when
 * focus leaves instead. Without JavaScript it is an ordinary field and the
 * form's Search button applies it.
 */
export function AutoSubmitSelect({
  name, defaultValue, label, children, className,
}: {
  name: string;
  defaultValue: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const viaKeyboard = useRef(false);
  const dirty = useRef(false);

  const submit = (el: HTMLSelectElement) => {
    dirty.current = false;
    el.form?.requestSubmit();
  };

  return (
    <select
      name={name}
      defaultValue={defaultValue}
      aria-label={label}
      onPointerDown={() => { viaKeyboard.current = false; }}
      onKeyDown={(e) => {
        viaKeyboard.current = true;
        if (e.key === "Enter" && dirty.current) {
          e.preventDefault();
          submit(e.currentTarget);
        }
      }}
      onChange={(e) => {
        if (viaKeyboard.current) dirty.current = true;
        else submit(e.currentTarget);
      }}
      onBlur={(e) => { if (dirty.current) submit(e.currentTarget); }}
      className={className}
    >
      {children}
    </select>
  );
}
