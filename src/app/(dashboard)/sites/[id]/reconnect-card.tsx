"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { reconnectSiteAction } from "./manage-actions";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { buttonClass, cardClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";
import { StatusBadge } from "@/components/ui/primitives";

/**
 * Replaces a site's WordPress application password.
 *
 * Application passwords are revoked and rotated as a matter of routine, and
 * until this existed there was no way back: a site whose credential lapsed
 * could only be fixed by deleting and re-adding it, which loses its id, its
 * per-site grants, and every snapshot and report attached to it. The panel's
 * own error message pointed here ("Reconnect it to update the application
 * password") for weeks before the flow existed.
 *
 * Two presentations, one form. When the site is actually broken this is a
 * banner at the top of the page, because it is the only thing worth doing
 * until it is fixed. Otherwise it is a quiet row inside the Connection card,
 * because rotating a working credential is planned maintenance, not an
 * emergency, and a permanent red banner teaches people to ignore red banners.
 */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass("primary")}>
      {pending && <IconSpinner size={16} />}
      {pending ? "Checking the connection…" : "Reconnect"}
    </button>
  );
}

export function ReconnectCard({
  siteId, siteName, siteEnv, wpUsername, needsReconnect,
}: {
  siteId: string;
  siteName: string;
  /** " (STAGING)" or "". See site-heading.tsx. */
  siteEnv: string;
  /** Current username, pre-filled: a rotation usually keeps the same user. */
  wpUsername: string | null;
  needsReconnect: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(reconnectSiteAction.bind(null, siteId), null);
  const { toast } = useToast();

  useEffect(() => {
    if (state?.ok) {
      setOpen(false);
      toast({
        tone: "success",
        title: `${siteName} reconnected`,
        description: "The credential was verified against the live site before it was saved.",
      });
    }
  }, [state, siteName, toast]);

  const form = (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="wp_username" className={labelClass}>
          WordPress username
        </label>
        <input
          id="wp_username"
          name="wp_username"
          defaultValue={wpUsername ?? ""}
          required
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="app_password" className={labelClass}>
          Application password
        </label>
        <input
          id="app_password"
          name="app_password"
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
          className={`${inputClass} font-mono`}
          aria-describedby="app_password_hint"
        />
        <p id="app_password_hint" className="text-caption tracking-normal text-mid-gray">
          WP Admin → Users → Profile → Application Passwords. Paste the whole value, spaces and
          all. This replaces the stored one only after it is checked against the live site.
        </p>
      </div>

      {state && !state.ok && (
        <p aria-live="polite" className="flex items-start gap-2 text-body text-ember">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{state.error}</span>
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={() => setOpen(false)} className={buttonClass("secondary")}>
          Cancel
        </button>
        <SubmitButton />
      </div>
    </form>
  );

  return (
    <>
      {needsReconnect ? (
        <div
          className={`${cardClass} mb-6 flex flex-wrap items-center justify-between gap-4 p-5`}
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="bad">Connection lost</StatusBadge>
              <p className="text-body font-medium text-ink">
                This site can’t be managed until it is reconnected
              </p>
            </div>
            <p className="mt-1 text-body text-mid-gray">
              WordPress rejected the stored application password. Scans, updates and reports for{" "}
              {siteName} are paused until a working one is saved.
            </p>
          </div>
          <button type="button" onClick={() => setOpen(true)} className={buttonClass("primary")}>
            Reconnect
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-5 py-3">
          <div className="min-w-0">
            <p className="text-body text-mid-gray">Application password</p>
            <p className="text-caption tracking-normal text-mid-gray">
              Replace it after rotating the password in WordPress.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={buttonClass("outline", "sm")}
          >
            Replace
          </button>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Reconnect ${siteName}${siteEnv}`}
        description="The new password is checked against the live site before anything is saved, so a wrong one leaves the site exactly as it is."
      >
        {form}
      </Modal>
    </>
  );
}
