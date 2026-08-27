"use client";

import { useActionState } from "react";
import { createSite } from "./actions";

export default function NewSitePage() {
  const [state, action, pending] = useActionState(createSite, undefined);
  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-2xl font-semibold">Connect a WordPress site</h1>
      <form action={action} className="space-y-4 rounded-lg border bg-white p-6 shadow-sm">
        <div className="space-y-1">
          <label htmlFor="name" className="text-sm font-medium">
            Site name
          </label>
          <input
            id="name"
            name="name"
            required
            placeholder="El Nido Guide"
            autoComplete="off"
            className="w-full rounded border px-3 py-2"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="url" className="text-sm font-medium">
            Site URL
          </label>
          <input
            id="url"
            name="url"
            type="url"
            required
            placeholder="https://example.com"
            autoComplete="off"
            className="w-full rounded border px-3 py-2"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="wpUsername" className="text-sm font-medium">
            WordPress username
          </label>
          <input
            id="wpUsername"
            name="wpUsername"
            required
            autoComplete="off"
            className="w-full rounded border px-3 py-2"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="appPassword" className="text-sm font-medium">
            Application password
          </label>
          <input
            id="appPassword"
            name="appPassword"
            type="password"
            required
            autoComplete="off"
            className="w-full rounded border px-3 py-2"
          />
          <span className="text-xs font-normal text-slate-500">
            WP Admin → Users → Profile → Application Passwords. Requires the Novamira plugin active.
          </span>
        </div>

        <div className="space-y-1">
          <label htmlFor="clientLabel" className="text-sm font-medium">
            Client label (optional)
          </label>
          <input
            id="clientLabel"
            name="clientLabel"
            autoComplete="off"
            className="w-full rounded border px-3 py-2"
          />
        </div>

        {state?.error && (
          <p className="text-sm text-red-600" aria-live="polite">
            {state.error}
          </p>
        )}

        <button
          disabled={pending}
          className="w-full rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {pending ? "Verifying connection…" : "Connect site"}
        </button>
      </form>
    </main>
  );
}
