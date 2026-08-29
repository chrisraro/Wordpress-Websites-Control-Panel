"use client";

import { useActionState } from "react";
import { createSite } from "./actions";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { buttonClass, cardClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";

export default function NewSitePage() {
  const [state, action, pending] = useActionState(createSite, undefined);

  return (
    <main className="mx-auto max-w-xl">
      <Breadcrumbs items={[{ label: "Sites", href: "/dashboard" }, { label: "Connect a site" }]} />

      <h1 className="text-heading-sm font-semibold text-ink">Connect a WordPress site</h1>
      <p className="mt-1 text-body text-mid-gray">
        We verify the connection before saving, so you will know immediately if the credentials
        or the Novamira plugin need attention.
      </p>

      <form action={action} className={`${cardClass} mt-6 space-y-5 p-5`}>
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
    </main>
  );
}
