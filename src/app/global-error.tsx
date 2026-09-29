"use client";

import "./globals.css";
import { useEffect } from "react";
import { buttonClass, cardClass } from "@/components/ui/styles";

/**
 * Last-resort boundary for errors thrown by the root layout itself (or by
 * anything a nested error.tsx cannot catch). It replaces the root layout, so
 * it must render its own <html> and <body> and cannot rely on the shell,
 * fonts provider or toasts being there.
 *
 * As in (dashboard)/error.tsx, the raw message is shown only in development;
 * production shows the digest, which matches the server log entry.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const showDetail = process.env.NODE_ENV === "development";

  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas font-geist text-body text-ink antialiased">
        <main className="flex min-h-screen items-center justify-center p-4">
          <div role="alert" className={`${cardClass} flex w-full max-w-md flex-col gap-3 p-5`}>
            <h1 className="text-heading-sm font-semibold text-ink">
              The control panel could not load
            </h1>
            <p className="text-body text-mid-gray">
              Something failed before the page could be shown. Try again; if it
              keeps happening, share the reference below with whoever maintains
              the panel.
            </p>
            {error.digest && (
              <p className="text-caption tracking-normal text-mid-gray">
                Reference: <code data-tabular className="text-ink">{error.digest}</code>
              </p>
            )}
            {showDetail && error.message && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] bg-canvas px-4 py-3 font-mono text-caption tracking-normal text-ink">
                {error.message}
              </pre>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => reset()} className={buttonClass("primary")}>
                Try again
              </button>
              {/* A plain anchor, not next/link: the router itself may be what failed. */}
              <a href="/dashboard" className={buttonClass("outline")}>
                Back to dashboard
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
