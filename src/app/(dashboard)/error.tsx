"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Card } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";

/**
 * Error boundary for every page under (dashboard). It renders inside
 * (dashboard)/layout.tsx, so the sidebar, command palette and skip link stay
 * put and the operator can navigate away instead of facing a blank tab.
 *
 * The raw error message is deliberately NOT shown outside development: a
 * client-side error can carry whatever string the failing code built (a site
 * URL, a response body), and Next already strips server messages in
 * production. The digest is what ties this screen to the server log line, so
 * that is what the operator can quote.
 */
export default function DashboardError({
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
    <Card className="mx-auto mt-6 max-w-xl p-5" as="div">
      <div role="alert" className="flex flex-col gap-3">
        <h1 className="text-heading-sm font-semibold text-ink">
          This page ran into a problem
        </h1>
        <p className="text-body text-mid-gray">
          Something went wrong while loading this page. Try again; if it keeps
          failing, share the reference below with whoever maintains the panel.
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
          <Link href="/dashboard" className={buttonClass("outline")}>
            Back to dashboard
          </Link>
        </div>
      </div>
    </Card>
  );
}
