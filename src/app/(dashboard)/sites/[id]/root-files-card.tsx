"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Card, CardTitle, EmptyState, StatusBadge } from "@/components/ui/primitives";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { buttonClass, inputClass, labelClass, badgeClass } from "@/components/ui/styles";
import { IconAlert, IconExternal, IconSpinner } from "@/components/ui/icons";
import {
  listRootFilesAction, readRootFileAction, saveRootFileAction, deleteRootFileAction,
  uploadRootFileAction,
} from "./root-file-actions";
import {
  ALLOWED_EXTENSIONS, MAX_ROOT_FILE_BYTES, SENSITIVE_ROOT_FILES,
} from "@/services/rootfiles/types";
import type { RootFile } from "@/services/rootfiles/types";

/**
 * Static files in the site's document root: upload, edit in place, replace,
 * and remove.
 *
 * The job this exists for is proving ownership to a search engine -- Google
 * Search Console hands you a file like `google<token>.html` and will only
 * verify the property once that exact file answers at the domain root. Doing
 * that used to mean SFTP or a host file manager, outside this panel
 * entirely, and it is the reason four Azalea sites were verified by hand.
 *
 * Deliberately not a file manager. It reaches one directory, writes five
 * inert extensions, and refuses WordPress's own files. `.php` is absent from
 * the allowlist on purpose: writing PHP into the document root is remote code
 * execution on a live client site, which is a different feature with a
 * different conversation attached, not a wider list.
 *
 * Loaded on demand rather than with the page. Listing costs an MCP round trip
 * and PHP execution on the live site, and this card is not what anyone opens
 * the site page to see -- so it fetches when expanded, the way the abilities
 * list beside it does.
 */
export function RootFilesCard({
  siteId, siteName, siteEnv,
}: {
  siteId: string;
  siteName: string;
  /** " (STAGING)" or "", for confirmations. See site-heading.tsx. */
  siteEnv: string;
}) {
  const [files, setFiles] = useState<RootFile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [pending, startAction] = useTransition();
  const [editing, setEditing] = useState<{ name: string; content: string } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);
  const { toast } = useToast();
  const loadedOnce = useRef(false);

  const load = useCallback(() => {
    startLoad(async () => {
      const res = await listRootFilesAction(siteId);
      if (res.ok) {
        setFiles(res.files ?? []);
        setLoadError(null);
      } else {
        setLoadError(res.error ?? "Could not list files");
      }
    });
  }, [siteId]);

  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    load();
  }, [load]);

  const openEditor = (name: string) => {
    startAction(async () => {
      const res = await readRootFileAction(siteId, name);
      if (!res.ok) {
        toast({ tone: "error", title: "Could not open the file", description: res.error });
        return;
      }
      if (!res.isText) {
        // Handing non-UTF-8 bytes to a textarea and saving would silently
        // rewrite them. Say so instead of corrupting the file.
        toast({
          tone: "error",
          title: "This file isn’t editable here",
          description: "It contains bytes that aren’t text. Replace it by uploading a new copy.",
        });
        return;
      }
      setEditing({ name, content: res.content ?? "" });
    });
  };

  const save = () => {
    if (!editing) return;
    setConfirmSave(false);
    startAction(async () => {
      const res = await saveRootFileAction(siteId, editing.name, editing.content);
      if (!res.ok) {
        toast({ tone: "error", title: "Could not save", description: res.error });
        return;
      }
      toast({ tone: "success", title: `Saved ${editing.name}`, description: res.url });
      setEditing(null);
      load();
    });
  };

  const remove = (name: string) => {
    setConfirmDelete(null);
    startAction(async () => {
      const res = await deleteRootFileAction(siteId, name);
      if (!res.ok) {
        toast({ tone: "error", title: "Could not delete", description: res.error });
        return;
      }
      toast({ tone: "success", title: `Deleted ${name}` });
      load();
    });
  };

  const busy = loading || pending;

  return (
    <Card>
      <CardTitle>Root files</CardTitle>

      <div className="px-5 pb-2">
        <p className="text-body text-mid-gray">
          Static files served from this site’s address, such as a Google Search Console
          verification file. {ALLOWED_EXTENSIONS.join(", ")} up to{" "}
          {MAX_ROOT_FILE_BYTES / 1024} KB.
        </p>
      </div>

      {loadError && (
        // break-words as well as the bounded message from friendlySiteError:
        // the Cloudflare interstitial is minified JavaScript with no spaces in
        // it, so without this it renders as one unbroken line that runs off
        // the side of the card instead of wrapping.
        <p className="flex items-start gap-2 px-5 pb-3 text-body text-ember">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{loadError}</span>
        </p>
      )}

      {files === null && !loadError ? (
        <p className="flex items-center gap-2 px-5 pb-4 text-body text-mid-gray">
          <IconSpinner size={16} /> Reading the document root…
        </p>
      ) : files && files.length === 0 ? (
        <div className="px-5 pb-4">
          <EmptyState title="Nothing here yet">
            Upload a verification file and it will be served from the site’s address straight
            away.
          </EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {(files ?? []).map((f) => (
            <li key={f.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-body font-medium text-ink">{f.name}</span>
                  {SENSITIVE_ROOT_FILES.has(f.name) && (
                    <span className={badgeClass("soft")}>affects search engines</span>
                  )}
                </div>
                <p className="text-caption tracking-normal text-mid-gray">
                  {f.bytes} bytes · {new Date(f.modified * 1000).toLocaleString()}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClass("ghost", "sm")}
                >
                  <IconExternal size={14} />
                  Open
                </a>
                <button
                  type="button"
                  onClick={() => openEditor(f.name)}
                  disabled={busy}
                  className={buttonClass("outline", "sm")}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(f.name)}
                  disabled={busy}
                  className={buttonClass("danger", "sm")}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-5 py-3">
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          disabled={busy}
          className={buttonClass("primary", "sm")}
        >
          Upload a file
        </button>
        <button type="button" onClick={load} disabled={busy} className={buttonClass("ghost", "sm")}>
          {loading && <IconSpinner size={14} />}
          Refresh
        </button>
      </div>

      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        siteId={siteId}
        siteName={siteName}
        siteEnv={siteEnv}
        onDone={() => {
          setUploadOpen(false);
          load();
        }}
      />

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing ? `Edit ${editing.name}` : ""}
        description={`Saving writes straight to ${siteName}${siteEnv}. The change is live immediately.`}
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className={buttonClass("secondary")}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setConfirmSave(true)}
              disabled={pending}
              className={buttonClass("primary")}
            >
              {pending && <IconSpinner size={16} />}
              Save
            </button>
          </>
        }
      >
        <label htmlFor="root-file-content" className={labelClass}>
          File contents
        </label>
        <textarea
          id="root-file-content"
          value={editing?.content ?? ""}
          onChange={(e) => setEditing((s) => (s ? { ...s, content: e.target.value } : s))}
          spellCheck={false}
          rows={14}
          className={`${inputClass} mt-1.5 min-h-48 resize-y font-mono text-caption tracking-normal`}
        />
      </Modal>

      <ConfirmDialog
        open={confirmSave}
        tone="danger"
        title={`Save ${editing?.name ?? ""} to ${siteName}${siteEnv}?`}
        confirmLabel="Save to the live site"
        onCancel={() => setConfirmSave(false)}
        onConfirm={save}
        description={
          <>
            <p>
              This replaces the file on the live site immediately. There is no previous version
              to restore from here.
            </p>
            {editing && SENSITIVE_ROOT_FILES.has(editing.name) && (
              <p className="mt-2 text-ember">
                {editing.name} tells search engines how to treat this site. A mistake here can
                remove it from search results, and nothing in this panel would report that.
              </p>
            )}
          </>
        }
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        tone="danger"
        title={`Delete ${confirmDelete ?? ""} from ${siteName}${siteEnv}?`}
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        description={
          <>
            <p>
              The file stops being served straight away. This cannot be undone from here.
            </p>
            <p className="mt-2">
              If a search engine verified this site using it, that verification will lapse the
              next time it is checked.
            </p>
          </>
        }
      />
    </Card>
  );
}

/**
 * Upload, with the filename editable before it lands.
 *
 * The rename is not a nicety. Downloading the same verification file twice
 * gets you `google<token>-1.html`, and uploading that produces a file the
 * search engine never asks for — the failure is silent and only shows up as
 * "verification failed" days later.
 */
function UploadDialog({
  open, onClose, siteId, siteName, siteEnv, onDone,
}: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  siteName: string;
  siteEnv: string;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setName("");
    setPicked(null);
    setError(null);
  }, [open]);

  const submit = () => {
    if (!picked) {
      setError("Choose a file to upload.");
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("file", picked);
    fd.set("name", name.trim());
    startTransition(async () => {
      const res = await uploadRootFileAction(siteId, null, fd);
      if (!res.ok) {
        setError(res.error ?? "The upload failed");
        return;
      }
      toast({
        tone: "success",
        title: res.replaced ? `Replaced ${name || picked.name}` : `Uploaded ${name || picked.name}`,
        description: res.url,
      });
      onDone();
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Upload to ${siteName}${siteEnv}`}
      description="The file is served from the site’s address as soon as it lands."
      footer={
        <>
          <button type="button" onClick={onClose} className={buttonClass("secondary")}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || !picked}
            className={buttonClass("primary")}
          >
            {pending && <IconSpinner size={16} />}
            {pending ? "Uploading…" : "Upload"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="root-file-input" className={labelClass}>
            File
          </label>
          <input
            id="root-file-input"
            type="file"
            accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",")}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setPicked(f);
              if (f && !name) setName(f.name);
              setError(null);
            }}
            className={`${inputClass} file:mr-3 file:rounded-2xl file:border-0 file:bg-canvas
              file:px-3 file:py-1 file:text-body file:text-ink`}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="root-file-name" className={labelClass}>
            Save as
          </label>
          <input
            id="root-file-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            className={`${inputClass} font-mono`}
            aria-describedby="root-file-name-hint"
          />
          <p id="root-file-name-hint" className="text-caption tracking-normal text-mid-gray">
            Check this matches exactly what you were asked to publish. A browser that has
            downloaded the file twice appends “-1”, which verification will not accept.
          </p>
        </div>

        {/* Said before the first upload rather than buried in a doc: a page
            served from the site's own origin can run script with the site's
            cookies. */}
        <p className="text-caption tracking-normal text-mid-gray">
          Anything you upload is public and served from this site’s domain. A script inside an
          HTML file runs as if the site itself served it.
        </p>

        {error && (
          <p aria-live="polite" className="flex items-start gap-2 text-body text-ember">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
