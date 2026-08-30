"use server";

import { redirect } from "next/navigation";

/**
 * The plugin and theme search boxes used to be plain
 * `<form action="/marketplace" method="get">` — a native browser
 * navigation with no pending state, on the single slowest round trip in
 * this app (a live call out to wordpress.org). Routing the submit through a
 * Server Action instead of a URL string keeps the same shareable,
 * bookmarkable `?q=` URL (the action's only job is to `redirect` to it),
 * but it also turns the submission into something React tracks: a plain
 * string `action` gives `useFormStatus` nothing to report, while a function
 * `action` lets `SubmitButton` (components/ui/submit-button.tsx) show the
 * search as in flight without lifting any state into this Server Component
 * page or converting it to a Client Component.
 */
export async function searchPluginsAction(formData: FormData) {
  const q = String(formData.get("q") ?? "").trim();
  redirect(q ? `/marketplace?q=${encodeURIComponent(q)}` : "/marketplace");
}

export async function searchThemesAction(formData: FormData) {
  const q = String(formData.get("q") ?? "").trim();
  redirect(q ? `/marketplace/themes?q=${encodeURIComponent(q)}` : "/marketplace/themes");
}
