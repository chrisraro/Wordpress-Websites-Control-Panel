"use client";

import { useEffect, useState } from "react";

/**
 * A timestamp in the viewer's own locale and time zone, safe to render from a
 * Client Component that is also server-rendered.
 *
 * toLocaleString()/toLocaleDateString() during render produce different text
 * on the server (the deployment's locale and UTC) and in the browser (the
 * operator's), which is a hydration mismatch. So the first render -- the one
 * the server and the hydrating client must agree on -- shows a deterministic
 * UTC ISO form, and the locale form is swapped in after mount.
 */
export function LocalTime({
  iso,
  mode = "datetime",
}: {
  iso: string;
  mode?: "date" | "datetime";
}) {
  const [local, setLocal] = useState<string | null>(null);

  useEffect(() => {
    const d = new Date(iso);
    setLocal(mode === "date" ? d.toLocaleDateString() : d.toLocaleString());
  }, [iso, mode]);

  return (
    <time dateTime={iso}>
      {local ?? isoFallback(iso, mode)}
    </time>
  );
}

/** Deterministic, locale-free text for the server/first-client render. */
export function isoFallback(iso: string, mode: "date" | "datetime"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = d.toISOString();
  return mode === "date" ? s.slice(0, 10) : `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}
