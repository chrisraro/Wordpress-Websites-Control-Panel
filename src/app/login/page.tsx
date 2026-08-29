"use client";

import Image from "next/image";
import { useActionState } from "react";
import { login } from "./actions";
import { GeoGridField } from "./geogrid-field";
import { buttonClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";

/**
 * Split-screen auth. The brand panel is desktop-only on purpose: at 375px the
 * only thing that matters is signing in, and a decorative half-screen would
 * push the form below the fold to say nothing. Mobile keeps the mark and the
 * name, which is the part that carries identity.
 *
 * The panel comes first in the DOM so visual order and tab order agree —
 * reordering with CSS would put a keyboard user's first stop somewhere the eye
 * isn't. Nothing in the panel is focusable, so it costs no tab stops.
 *
 * The form is not wrapped in a card. On a split screen the column already is
 * the surface; a card inside it is a box in a box.
 */
export default function LoginPage() {
  const [state, action, pending] = useActionState(login, undefined);

  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[1fr_minmax(0,34rem)]">
      <aside className="relative hidden overflow-hidden bg-[#111111] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <GeoGridField className="pointer-events-none absolute inset-0 h-full w-full" />

        {/* Keeps the lower copy legible where the lattice is densest, without
            dimming the field itself. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3"
          style={{ background: "linear-gradient(to top, #111111 12%, transparent 100%)" }}
        />

        <Image
          src="/brand/icon-192.png"
          alt=""
          width={44}
          height={44}
          className="relative shrink-0"
        />

        <div className="relative max-w-md">
          <h2 className="text-heading-lg font-semibold tracking-[-0.025em] text-white text-balance">
            Every client site, one panel.
          </h2>
          {/* Tinted from the panel's own accent rather than gray — gray on a
              near-black brand surface reads as a disabled state. */}
          <p className="mt-3 text-body-lg" style={{ color: "#c9cfba" }}>
            Local rank, uptime, security scans, plugin and theme updates, and
            client-ready reports for every WordPress site Online Creative
            Solutions runs.
          </p>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col justify-center bg-paper px-6 py-12 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <Image
            src="/brand/icon-192.png"
            alt=""
            width={40}
            height={40}
            className="mb-5 lg:hidden"
          />

          {/* The product name is the heading, not "Sign in". The brand panel
              is desktop-only, so on a phone this line is the only thing that
              says what you are signing into — and a generic verb would leave
              mobile with no identity at all. */}
          <h1 className="text-heading-sm font-semibold tracking-[-0.025em] text-ink text-balance sm:text-heading">
            OCS Wordpress Control Panel
          </h1>
          <p className="mt-2 text-body text-mid-gray">
            Sign in to continue.
          </p>

          <form action={action} className="mt-8 space-y-5">
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
                autoFocus
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

          <p className={`${hintClass} mt-6`}>
            Access is invite-only. Ask an administrator to add your account.
          </p>
        </div>
      </div>
    </main>
  );
}
