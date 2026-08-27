"use client";

import { useActionState } from "react";
import { login } from "./actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form action={action} className="w-full max-w-sm space-y-4 rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">WP Control Panel</h1>
        <div className="space-y-1">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input id="email" name="email" type="email" required
            autoComplete="email"
            className="w-full rounded border px-3 py-2" />
        </div>
        <div className="space-y-1">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <input id="password" name="password" type="password" required
            autoComplete="current-password"
            className="w-full rounded border px-3 py-2" />
        </div>
        <p className="min-h-5 text-sm text-red-600" aria-live="polite">
          {state?.error}
        </p>
        <button disabled={pending}
          className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50">
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
