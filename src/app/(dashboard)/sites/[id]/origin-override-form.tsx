"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { setOriginAction } from "./manage-actions";
import { buttonClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";
import { StatusBadge } from "@/components/ui/primitives";

/**
 * Configures a direct-to-origin connection for a site whose CDN challenges
 * this app (0019_site_origin_override.sql, docs/ops/cloudflare.md).
 *
 * Collapsed by default. Eleven of twelve sites will never need it, and an
 * always-open pair of infrastructure fields on the site's main page is
 * clutter that trains people to skip the card it sits in.
 *
 * The copy avoids "bypass Cloudflare", which invites the reading that this
 * turns off security. It does not: certificate verification stays on and is
 * checked against the name entered below. What changes is which address the
 * connection goes to.
 */
function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass("outline", "sm")}>
      {pending && <IconSpinner size={14} />}
      {pending ? "Saving…" : label}
    </button>
  );
}

export function OriginOverrideForm({
  siteId, siteName, originIp, originSni,
}: {
  siteId: string;
  siteName: string;
  originIp: string | null;
  originSni: string | null;
}) {
  const configured = Boolean(originIp && originSni);
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(setOriginAction.bind(null, siteId), null);

  return (
    <div className="border-t border-hairline px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body text-mid-gray">Direct connection</p>
            {configured ? (
              <StatusBadge tone="good">On</StatusBadge>
            ) : (
              <StatusBadge tone="idle">Off</StatusBadge>
            )}
          </div>
          <p className="text-caption tracking-normal text-mid-gray">
            {configured
              ? `Connecting to ${originIp} directly, verifying the certificate for ${originSni}.`
              : "Use when a CDN in front of this site blocks the panel."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={buttonClass("ghost", "sm")}
          aria-expanded={open}
        >
          {open ? "Close" : configured ? "Change" : "Set up"}
        </button>
      </div>

      {open && (
        <form action={formAction} className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="origin_ip" className={labelClass}>
              Origin IP address
            </label>
            <input
              id="origin_ip"
              name="origin_ip"
              defaultValue={originIp ?? ""}
              placeholder="192.0.2.10"
              spellCheck={false}
              className={`${inputClass} font-mono`}
              aria-describedby="origin_ip_hint"
            />
            <p id="origin_ip_hint" className="text-caption tracking-normal text-mid-gray">
              The hosting server’s own address. Must be a literal IP — a hostname would be
              resolved by the same DNS that returns the CDN, which is the thing being stepped
              around.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="origin_sni" className={labelClass}>
              Certificate name
            </label>
            <input
              id="origin_sni"
              name="origin_sni"
              defaultValue={originSni ?? ""}
              placeholder="server123.yourhost.com"
              spellCheck={false}
              className={`${inputClass} font-mono`}
              aria-describedby="origin_sni_hint"
            />
            <p id="origin_sni_hint" className="text-caption tracking-normal text-mid-gray">
              The name on the certificate that server presents — usually your host’s shared
              hostname. The certificate is still fully verified against it; this only says
              which name to check. Leave both fields empty to turn the direct connection off.
            </p>
          </div>

          <p className="text-caption tracking-normal text-mid-gray">
            {siteName}’s own address still identifies which site is served, so nothing else
            changes. If your host migrates the account, this address goes stale and the site
            stops connecting — “Test connection” above is the check.
          </p>

          {state && !state.ok && (
            <p aria-live="polite" className="flex items-start gap-2 text-body text-ember">
              <IconAlert size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{state.error}</span>
            </p>
          )}
          {state?.ok && (
            <p aria-live="polite" className="text-body text-status-good">
              Saved. Use “Test connection” to confirm it works.
            </p>
          )}

          <SubmitButton label={configured ? "Save changes" : "Turn on"} />
        </form>
      )}
    </div>
  );
}
