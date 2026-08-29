"use client";

import Image from "next/image";
import { useActionState } from "react";
import { login } from "./actions";
import { buttonClass, cardClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <Image
            src="/brand/icon-64.png"
            alt=""
            width={40}
            height={40}
            className="mx-auto mb-3"
          />
          <h1 className="text-heading-sm font-semibold text-ink">OCS Wordpress Control Panel</h1>
          <p className="mt-1 text-body text-mid-gray">Sign in to manage your WordPress sites.</p>
        </div>

        <form action={action} className={`${cardClass} animate-rise space-y-5 p-5`}>
          <div className="space-y-1.5">
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className={labelClass}>
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className={inputClass}
            />
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
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className={`${hintClass} mt-4 text-center`}>
          Access is invite-only. Ask an administrator to add your account.
        </p>
      </div>
    </main>
  );
}
