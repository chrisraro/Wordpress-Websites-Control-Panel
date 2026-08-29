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
