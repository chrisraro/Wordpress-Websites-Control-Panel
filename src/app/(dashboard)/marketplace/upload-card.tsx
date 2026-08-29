"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { createInstallBatchAction, prepareUploadAction } from "./actions";
import type { SiteOption } from "./install-panel";
import { useToast } from "@/components/ui/toast";
import { Card, CardTitle } from "@/components/ui/primitives";
import { buttonClass, hintClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner, IconUpload } from "@/components/ui/icons";

const MAX_BYTES = 50 * 1024 * 1024;

export function UploadCard({ sites }: { sites: SiteOption[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activate, setActivate] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const fail = (message: string) => {
    setError(message);
    setStatus(null);
    toast({ tone: "error", title: "Upload failed", description: message });
  };

  const submit = () => {
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) return fail("Choose a plugin .zip file first");
    if (!/\.zip$/i.test(file.name)) return fail("Only .zip files are supported");
    if (file.size > MAX_BYTES) return fail("That file is over the 50MB limit");
    if (selected.size === 0) return fail("Select at least one site");

    startTransition(async () => {
      setStatus("Preparing…");
      const prep = await prepareUploadAction(file.name);
      if (!prep.ok || !prep.path || !prep.token) {
        return fail(prep.error ?? "Upload preparation failed");
      }
      setStatus("Uploading…");
      const supabase = createBrowserSupabase();
      const { error: upErr } = await supabase.storage
        .from("plugins")
        .uploadToSignedUrl(prep.path, prep.token, file);
      if (upErr) return fail(upErr.message);

      setStatus("Starting installs…");
      const res = await createInstallBatchAction({
        source: { kind: "upload", path: prep.path }, siteIds: [...selected], activate,
      });
      if (res.ok && res.batchId) {
        toast({
          tone: "success",
          title: "Upload complete",
          description: `Installing on ${selected.size} site${selected.size === 1 ? "" : "s"}.`,
        });
        router.push(`/marketplace/batches/${res.batchId}`);
      } else {
        fail(res.error ?? "Failed to start the install");
      }
    });
  };

  return (
    <Card>
      <CardTitle>Upload a plugin</CardTitle>
      <div className="space-y-4 p-5">
        <p className={hintClass}>
          For premium or in-house plugins that are not on wordpress.org. Max 50MB.
        </p>

        <div>
          <label className={`${buttonClass("outline", "md", "w-full cursor-pointer")}`}>
            <IconUpload size={16} />
            {fileName ?? "Choose .zip file"}
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
              className="sr-only"
            />
          </label>
          {fileName && (
            <p className={`${hintClass} mt-1.5 truncate`} title={fileName}>
              Selected: {fileName}
            </p>
          )}
        </div>

        <fieldset>
          <legend className="mb-1 text-body font-medium text-ink">Install on</legend>
          {sites.length === 0 ? (
            <p className={hintClass}>Connect a site first.</p>
          ) : (
            <div className="max-h-36 space-y-0.5 overflow-y-auto">
              {sites.map((s) => (
                <label
                  key={s.id}
                  className="flex min-h-10 cursor-pointer items-center gap-3 rounded-2xl px-2
                    transition-colors duration-150 hover:bg-canvas"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    className="size-4 shrink-0 rounded-md accent-ink"
                  />
                  <span className="min-w-0 flex-1 truncate text-body text-ink">{s.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-2xl px-2">
          <input
            type="checkbox"
            checked={activate}
            onChange={(e) => setActivate(e.target.checked)}
            className="size-4 shrink-0 rounded-md accent-ink"
          />
          <span className="text-body text-ink">Activate after install</span>
        </label>

        <button
          onClick={submit}
          disabled={pending || sites.length === 0}
          className={buttonClass("primary", "md", "w-full")}
        >
          {pending && <IconSpinner size={16} />}
          {pending ? (status ?? "Working…") : "Upload and install"}
        </button>

        {error && (
          <p aria-live="polite" className="flex items-start gap-2 text-body text-ember">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}
