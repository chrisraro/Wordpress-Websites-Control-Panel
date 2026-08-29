"use client";

/**
 * Per-site theme installer: search wordpress.org or upload a .zip, both
 * landing on the same `installThemeAction`. Modelled on the marketplace's
 * upload-card.tsx, with two differences forced by scope: this installs on
 * one already-known site (no site picker), and the wordpress.org search runs
 * through a thin server action (`searchWpThemesAction`) rather than a Server
 * Component page, since that API does not accept cross-origin browser
 * requests and this panel has to stay a Client Component for its two-step
 * upload flow.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { installThemeAction, prepareThemeUploadAction, searchWpThemesAction } from "./theme-actions";
import type { WpOrgTheme } from "@/lib/adapters/wporg";
import { useToast } from "@/components/ui/toast";
import { Card, CardTitle } from "@/components/ui/primitives";
import { buttonClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSearch, IconSpinner, IconUpload } from "@/components/ui/icons";

const MAX_BYTES = 50 * 1024 * 1024;

export function InstallPanel({ siteId, siteName }: { siteId: string; siteName: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WpOrgTheme[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activate, setActivate] = useState(true);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  function runInstall(
    source: { kind: "wporg"; slug: string } | { kind: "upload"; path: string },
    label: string,
  ) {
    setError(null);
    const fd = new FormData();
    fd.set("source", source.kind);
    if (source.kind === "wporg") fd.set("slug", source.slug);
    else fd.set("path", source.path);
    if (activate) fd.set("activate", "on");

    startTransition(async () => {
      const res = await installThemeAction(siteId, null, fd);
      if (res.ok) {
        toast({
          tone: "success",
          title: `${label} installed`,
          // WordPress's own message, so an activation it declined (missing parent
          // theme) is not reported here as a successful activation.
          description: res.message ?? (activate ? `Activated on ${siteName}.` : `Installed on ${siteName}.`),
        });
        router.refresh();
      } else {
        toast({ tone: "error", title: "Install failed", description: res.error ?? "The install could not be completed." });
      }
    });
  }

  function runSearch() {
    setSearchError(null);
    startTransition(async () => {
      const res = await searchWpThemesAction(query);
      setSearched(true);
      if (res.ok && res.result) {
        setResults(res.result.themes);
      } else {
        setResults([]);
        setSearchError(res.error ?? "wordpress.org search failed");
      }
    });
  }

  function submitUpload() {
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Choose a theme .zip file first");
    if (!/\.zip$/i.test(file.name)) return setError("Only .zip files are supported");
    if (file.size > MAX_BYTES) return setError("That file is over the 50MB limit");

    startTransition(async () => {
      setUploadStatus("Preparing…");
      const prep = await prepareThemeUploadAction(siteId, file.name);
      if (!prep.ok || !prep.path || !prep.token) {
        setUploadStatus(null);
        setError(prep.error ?? "Upload preparation failed");
        return;
      }
      setUploadStatus("Uploading…");
      const supabase = createBrowserSupabase();
      const { error: upErr } = await supabase.storage
        .from("themes")
        .uploadToSignedUrl(prep.path, prep.token, file);
      if (upErr) {
        setUploadStatus(null);
        setError(upErr.message);
        return;
      }
      setUploadStatus("Installing…");
      const fd = new FormData();
      fd.set("source", "upload");
      fd.set("path", prep.path);
      if (activate) fd.set("activate", "on");
      const res = await installThemeAction(siteId, null, fd);
      setUploadStatus(null);
      if (res.ok) {
        toast({
          tone: "success",
          title: "Upload complete",
          // WordPress's own message, so an activation it declined (missing parent
          // theme) is not reported here as a successful activation.
          description: res.message ?? (activate ? `Activated on ${siteName}.` : `Installed on ${siteName}.`),
        });
        setFileName(null);
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      } else {
        setError(res.error ?? "Failed to install the uploaded theme");
      }
    });
  }

  return (
    <Card>
      <CardTitle>Install a theme</CardTitle>
      <div className="space-y-6 p-5">
        <div>
          <label htmlFor="theme-search" className={labelClass}>
            Search wordpress.org
          </label>
          <div className="mt-1.5 flex gap-2">
            <div className="relative flex-1">
              <IconSearch
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mid-gray"
              />
              <input
                id="theme-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runSearch();
                  }
                }}
                placeholder="astra, storefront, blocksy…"
                className={`${inputClass} pl-9`}
              />
            </div>
            <button type="button" onClick={runSearch} disabled={pending} className={buttonClass("outline")}>
              {pending ? <IconSpinner size={16} /> : "Search"}
            </button>
          </div>

          {searchError && (
            <p className="mt-2 flex items-start gap-2 text-body text-ember">
              <IconAlert size={16} className="mt-0.5 shrink-0" />
              {searchError}
            </p>
          )}

          {searched && !searchError && results.length === 0 && (
            <p className={`${hintClass} mt-2`}>Nothing matched “{query}”.</p>
          )}

          {results.length > 0 && (
            <ul className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
              {results.map((t) => (
                <li
                  key={t.slug}
                  className="flex items-center gap-3 rounded-2xl border border-hairline p-2.5"
                >
                  {t.screenshot_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={t.screenshot_url}
                      alt=""
                      width={56}
                      height={40}
                      className="h-10 w-14 shrink-0 rounded-2xl border border-hairline object-cover"
                    />
                  ) : (
                    <div
                      aria-hidden
                      className="flex h-10 w-14 shrink-0 items-center justify-center rounded-2xl
                        border border-hairline bg-canvas text-caption font-medium text-mid-gray"
                    >
                      {t.name.charAt(0)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium text-ink" title={t.name}>
                      {t.name}
                    </p>
                    <p className="truncate text-caption tracking-normal text-mid-gray">
                      {t.author} · v{t.version}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => runInstall({ kind: "wporg", slug: t.slug }, t.name)}
                    disabled={pending}
                    className={buttonClass("outline", "sm")}
                  >
                    {pending ? <IconSpinner size={14} /> : "Install"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-hairline pt-5">
          <p className={labelClass}>Upload a .zip</p>
          <p className={`${hintClass} mt-1`}>
            For premium or in-house themes not on wordpress.org. Max 50MB.
          </p>
          <label className={`${buttonClass("outline", "md", "mt-2 w-full cursor-pointer")}`}>
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
            <button
              type="button"
              onClick={submitUpload}
              disabled={pending}
              className={buttonClass("primary", "md", "mt-2 w-full")}
            >
              {pending && <IconSpinner size={16} />}
              {uploadStatus ?? "Upload and install"}
            </button>
          )}
        </div>

        <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-2xl border-t border-hairline pt-4">
          <input
            type="checkbox"
            checked={activate}
            onChange={(e) => setActivate(e.target.checked)}
            className="size-4 shrink-0 rounded-md accent-ink"
          />
          <span className="text-body text-ink">Activate after install</span>
        </label>

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
