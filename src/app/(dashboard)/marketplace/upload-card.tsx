"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { createInstallBatchAction, prepareUploadAction } from "./actions";
import type { SiteOption } from "./install-panel";

const MAX_BYTES = 50 * 1024 * 1024;

export function UploadCard({ sites }: { sites: SiteOption[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activate, setActivate] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
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
    const file = fileRef.current?.files?.[0];
    if (!file) { setError("Choose a plugin .zip file first"); return; }
    if (!/\.zip$/i.test(file.name)) { setError("Only .zip files are supported"); return; }
    if (file.size > MAX_BYTES) { setError("File exceeds the 50MB limit"); return; }
    if (selected.size === 0) { setError("Select at least one site"); return; }

    startTransition(async () => {
      setStatus("Preparing upload…");
      const prep = await prepareUploadAction(file.name);
      if (!prep.ok || !prep.path || !prep.token) {
        setError(prep.error ?? "Upload preparation failed"); setStatus(null); return;
      }
      setStatus("Uploading…");
      const supabase = createBrowserSupabase();
      const { error: upErr } = await supabase.storage
        .from("plugins").uploadToSignedUrl(prep.path, prep.token, file);
      if (upErr) { setError(`Upload failed: ${upErr.message}`); setStatus(null); return; }
      setStatus("Starting installs…");
      const res = await createInstallBatchAction({
        source: { kind: "upload", path: prep.path }, siteIds: [...selected], activate,
      });
      if (res.ok && res.batchId) router.push(`/marketplace/batches/${res.batchId}`);
      else { setError(res.error ?? "Failed to start install"); setStatus(null); }
    });
  };

  return (
    <section className="rounded-lg border bg-white p-4 shadow-sm">
      <h2 className="mb-2 font-medium">Upload a plugin</h2>
      <p className="mb-3 text-xs text-slate-500">
        Upload a plugin .zip (e.g. a premium plugin) and install it on selected sites.
      </p>
      <div className="space-y-2 text-sm">
        <label className="block">
          <span className="sr-only">Plugin zip file</span>
          <input ref={fileRef} type="file" accept=".zip,application/zip"
            className="block w-full text-sm file:mr-3 file:min-h-10 file:rounded file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-white" />
        </label>
        <div className="max-h-32 space-y-1 overflow-y-auto">
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
        <button onClick={submit} disabled={pending}
          className="min-h-10 w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50">
          {pending ? (status ?? "Working…") : "Upload & install"}
        </button>
        <p aria-live="polite" className="min-h-4 text-xs text-red-600">{error}</p>
      </div>
    </section>
  );
}
