"use client";

import { useActionState } from "react";
import { createSite } from "./actions";
import { buttonClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";

/**
 * The connect-a-site form itself: fields, validation, pending state, and
 * error display. Deliberately excludes page chrome (breadcrumbs, heading,
 * intro copy, card surface) so it can be rendered both as a full page
 * (sites/new/page.tsx via NewSiteForm) and inside the intercepting modal
 * (@modal/(.)sites/new/page.tsx) without a second copy of the credential
 * handling logic drifting from this one.
 */
export function ConnectSiteForm() {
  const [state, action, pending] = useActionState(createSite, undefined);

  return (
    <form action={action} className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="name" className={labelClass}>
          Site name
        </label>
        <input id="name" name="name" required placeholder="El Nido Guide" className={inputClass} />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="url" className={labelClass}>
          Site URL
        </label>
        <input
          id="url"
          name="url"
          type="url"
          required
          placeholder="https://example.com"
          autoComplete="url"
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="wpUsername" className={labelClass}>
          WordPress username
        </label>
        <input
          id="wpUsername"
          name="wpUsername"
          required
          autoComplete="username"
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="appPassword" className={labelClass}>
          Application password
        </label>
        <input
          id="appPassword"
          name="appPassword"
          type="password"
          required
          autoComplete="off"
          aria-describedby="appPassword-hint"
          className={inputClass}
        />
        <p id="appPassword-hint" className={hintClass}>
          WP Admin → Users → Profile → Application Passwords. The Novamira plugin must be active.
        </p>
      </div>

      {/* Required, and deliberately not pre-selected. This is the one moment
          the operator knows the answer for certain -- before this field, a
          regex over the URL guessed it and the guess became permanent truth
          for the constraint PRODUCT.md calls hardest. A pre-filled default
          would let a wrong guess through unread, which is the failure this
          field exists to stop, so neither option starts checked.

          Radios rather than a select: two mutually exclusive options that
          both need to be read before choosing, and a closed select shows
          only one of them. */}
      <fieldset className="space-y-1.5">
        <legend className={labelClass}>Environment</legend>
        <p className={hintClass}>
          Which one this is. It is shown beside the site’s name everywhere, and in every
          confirmation before an action runs.
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          {(
            [
              ["production", "Production", "The live site your client’s visitors see."],
              ["staging", "Staging", "A copy for testing. Marked everywhere as STAGING."],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className="flex flex-1 cursor-pointer items-start gap-3 rounded-2xl border
                border-hairline p-3 transition-colors duration-150 hover:bg-canvas
                has-[:checked]:border-ink has-[:checked]:bg-canvas
                has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2
                has-[:focus-visible]:outline-ink"
            >
              <input
                type="radio"
                name="environment"
                value={value}
                required
                className="mt-0.5 size-4 shrink-0 accent-ink"
              />
              <span className="min-w-0">
                <span className="block text-body font-medium text-ink">{label}</span>
                <span className="block text-caption tracking-normal text-mid-gray">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <label htmlFor="clientLabel" className={labelClass}>
          Client label <span className="font-normal text-mid-gray">(optional)</span>
        </label>
        <input id="clientLabel" name="clientLabel" className={inputClass} />
      </div>

      <div aria-live="polite" className="min-h-5">
        {state?.error && (
          <p className="flex items-start gap-2 text-body text-ember">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            {state.error}
          </p>
        )}
      </div>

      <button disabled={pending} className={buttonClass("primary", "md", "w-full")}>
        {pending && <IconSpinner size={16} />}
        {pending ? "Verifying connection…" : "Connect site"}
      </button>
    </form>
  );
}
