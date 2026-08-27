"use client";

import { useActionState } from "react";
import { login } from "./actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form action={action} className="w-full max-w-sm space-y-4 rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">WP Control Panel</h1>
        <input name="email" type="email" required placeholder="Email"
          className="w-full rounded border px-3 py-2" />
        <input name="password" type="password" required placeholder="Password"
          className="w-full rounded border px-3 py-2" />
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
        <button disabled={pending}
          className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50">
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
