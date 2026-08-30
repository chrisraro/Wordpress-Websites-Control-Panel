"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClass } from "./styles";
import { IconSpinner } from "./icons";

/**
 * A submit button that shows pending state for a plain GET form.
 *
 * Why not `useFormStatus`, like SubmitButton does? Because `useFormStatus`
 * only reports on a form whose `action` is a *function*. Making the search
 * box satisfy that would mean turning an idempotent GET into a POST server
 * action — and a search box has every reason to stay a GET: it is
 * idempotent, shareable, bookmarkable, cacheable, survives the back button
 * with the query intact, and works before hydration. Trading all of that for
 * a spinner is the wrong way round, so the spinner adapts to the form
 * instead.
 *
 * (For the record: this revert was once justified partly by a session that
 * appeared to die on submit. That was a testing artefact — a script calling
 * requestSubmit() on `document.querySelector('form')`, which on a dashboard
 * page is the sidebar's sign-out form, not the search box. The search never
 * had that fault. The reasoning above stands on its own.)
 *
 * The pending state ends when the browser navigates and this component
 * unmounts, which is exactly the moment the results arrive. `pageshow`
 * resets it for the back/forward cache, where the old page is restored live
 * and would otherwise come back frozen mid-search.
 */
export function SearchSubmit({
  label,
  pendingLabel,
}: {
  label: string;
  pendingLabel: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = () => setPending(true);
    // Restored from the bfcache: the DOM is the old page, so clear the state
    // it was left in rather than showing a search that already finished.
    const onPageShow = () => setPending(false);
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return (
    <button
      ref={ref}
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={buttonClass("primary")}
    >
      {pending && <IconSpinner size={16} />}
      {pending ? pendingLabel : label}
    </button>
  );
}
