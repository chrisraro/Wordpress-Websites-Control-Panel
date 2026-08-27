"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInstallBatchAction } from "./actions";

export interface SiteOption { id: string; name: string }

export function InstallPanel({ slug, sites }: { slug: string; sites: SiteOption[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activate, setActivate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await createInstallBatchAction({
        source: { kind: "wporg", slug }, siteIds: [...selected], activate,
      });
      if (res.ok && res.batchId) router.push(`/marketplace/batches/${res.batchId}`);
      else setError(res.error ?? "Failed to start install");
    });
  };

  return (
    <details className="mt-2">
      <summary className="min-h-10 cursor-pointer rounded bg-slate-900 px-3 py-2 text-center text-sm text-white">
        Install…
      </summary>
      <div className="mt-2 space-y-2 rounded border bg-slate-50 p-3 text-sm">
        <p className="font-medium">Install on:</p>
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {sites.map((s) => (
            <label key={s.id} className="flex min-h-10 items-center gap-2">
              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
              <span className="truncate">{s.name}</span>
            </label>
          ))}
        </div>
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          Activate after install
        </label>
        <button onClick={submit} disabled={pending || selected.size === 0}
          className="min-h-10 w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50">
          {pending ? "Starting…" : `Install on ${selected.size} site(s)`}
        </button>
        <p aria-live="polite" className="min-h-4 text-xs text-red-600">{error}</p>
      </div>
    </details>
  );
}
