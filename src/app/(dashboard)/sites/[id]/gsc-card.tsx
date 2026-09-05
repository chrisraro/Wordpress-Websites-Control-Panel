"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { installVerificationAction, removeVerificationAction } from "./gsc-actions";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { buttonClass, cardClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconExternal, IconSpinner } from "@/components/ui/icons";
import { CardTitle, StatusBadge } from "@/components/ui/primitives";
import { GscBadge } from "./gsc-badge";
import type { GscStatus, GscVerification } from "@/services/gsc/types";

/**
 * Search Console verification: what is on the site, and how to change it.
 *
 * Offers the HTML-file method only. A meta tag lives in whichever SEO plugin
 * a site happens to run — three different option shapes across this fleet
 * already — and writing another plugin's settings from here would mean owning
 * its schema forever. Tokens a plugin already stores are shown, so the
 * picture is complete; they are simply managed where they live.
 */
function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass("primary")}>
      {pending && <IconSpinner size={16} />}
      {pending ? "Installing and checking…" : label}
    </button>
  );
}

export function GscCard({
  siteId, siteName, siteUrl, verification, status, canManage,
}: {
  siteId: string;
  siteName: string;
  siteUrl: string;
  verification: GscVerification | undefined;
  status: GscStatus | null;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const { toast } = useToast();
  const [state, formAction] = useActionState(installVerificationAction.bind(null, siteId), null);

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      setOpen(false);
      toast({ tone: "success", title: state.message ?? "Verification installed" });
    } else if (state.error) {
      toast({ tone: "error", title: "Could not install", description: state.error });
    }
  }, [state, toast]);

  const files = verification?.files ?? [];
  const base = siteUrl.replace(/\/+$/, "");

  return (
    <section className={`${cardClass} overflow-hidden`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <CardTitle>Search Console verification</CardTitle>
          {/* Said once, plainly, where the claim is made -- rather than
              letting a green badge imply something stronger than it means. */}
          <p className="mt-1 text-caption tracking-normal text-mid-gray">
            Whether a verification token is installed on this site. Only Google can say whether
            the property is verified.
          </p>
        </div>
        <GscBadge status={status} />
      </div>

      <div className="space-y-3 px-5 py-4">
        {status === null && (
          <p className="text-body text-mid-gray">
            This site has not been inventoried since verification checks were added. Refresh its
            inventory to find out.
          </p>
        )}

        {status && status.methods.length > 0 && (
          <ul className="space-y-1">
            {status.methods.map((m) => (
              <li key={m} className="flex items-center gap-2 text-body text-ink">
                <StatusBadge tone="good">{m}</StatusBadge>
              </li>
            ))}
          </ul>
        )}

        {status?.state === "none" && (
          <p className="text-body text-mid-gray">
            No verification file and no token stored by an SEO plugin. If {siteName} is already
            verified, it is through DNS or a linked Google account — neither of which this panel
            can see.
          </p>
        )}

        {status?.problems.map((p) => (
          <p key={p} className="flex items-start gap-2 text-body text-ember">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{p}</span>
          </p>
        ))}

        {files.length > 0 && (
          <ul className="divide-y divide-hairline border-t border-hairline">
            {files.map((f) => (
              <li key={f.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a
                  href={`${base}/${f.name}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-w-0 items-center gap-1.5 text-body text-ink underline
                    underline-offset-2 hover:text-mid-gray"
                >
                  <span className="truncate font-mono text-caption tracking-normal">{f.name}</span>
                  <IconExternal size={14} className="shrink-0" />
                </a>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => setRemoving(f.name)}
                    className={buttonClass("outline", "sm")}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canManage && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-5 py-3">
          <p className="text-caption tracking-normal text-mid-gray">
            Add the HTML file Google gave you for this property.
          </p>
          <button type="button" onClick={() => setOpen(true)} className={buttonClass("outline", "sm")}>
            {files.length > 0 ? "Add another" : "Install verification"}
          </button>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Install verification for ${siteName}`}
        description="Only the file name is needed. The panel writes the contents itself, so the name and the token inside can never disagree — which is the usual reason this method fails."
      >
        <form action={formAction} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="file_name" className={labelClass}>
              File name from Search Console
            </label>
            <input
              id="file_name"
              name="file_name"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="google1234abcd5678.html"
              className={`${inputClass} font-mono`}
              aria-describedby="file_name_hint"
            />
            <p id="file_name_hint" className="text-caption tracking-normal text-mid-gray">
              In Search Console choose the HTML file method; you need only the file name, not the
              downloaded file. After installing, the panel fetches the URL back to confirm the
              site really serves it before reporting success.
            </p>
          </div>

          {state && !state.ok && state.error && (
            <p aria-live="polite" className="flex items-start gap-2 text-body text-ember">
              <IconAlert size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{state.error}</span>
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setOpen(false)} className={buttonClass("secondary")}>
              Cancel
            </button>
            <SubmitButton label="Install" />
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing}?`}
        description={
          `If Google has already verified ${siteName} with this file, removing it can un-verify ` +
          "the property and you will lose access to its Search Console data until it is verified again."
        }
        confirmLabel="Remove"
        tone="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const name = removing;
          setRemoving(null);
          if (!name) return;
          const r = await removeVerificationAction(siteId, name);
          if (r?.ok) toast({ tone: "success", title: r.message ?? "Removed" });
          else toast({ tone: "error", title: "Could not remove", description: r?.error });
        }}
      />
    </section>
  );
}
