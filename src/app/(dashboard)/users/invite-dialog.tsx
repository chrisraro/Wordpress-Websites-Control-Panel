"use client";

/**
 * The invite flow, end to end: a trigger button, the form, and — on success —
 * the one-time display of the invite link.
 *
 * No email is sent by this app. `generateLink` (see services/users/repo.ts)
 * only *creates* the link; nothing here, or anywhere else in this codebase,
 * delivers it. So the copy below never implies a message is on its way — it
 * tells the administrator, plainly, that sending the link is their job. The
 * dialog stays open after success so that link can be copied; it closes only
 * when explicitly dismissed, because closing it for them would throw the
 * link away with no way to get it back.
 */
import { useActionState, useEffect, useRef, useState } from "react";
import { inviteUserAction, type InviteResult } from "./actions";
import { Modal } from "@/components/ui/modal";
import { CopyValueButton } from "@/components/ui/copy-button";
import { useToast } from "@/components/ui/toast";
import { buttonClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconPlus, IconSpinner } from "@/components/ui/icons";
import { APP_ROLES, type AppRole } from "@/lib/authz/types";

const ROLE_LABEL: Record<AppRole, string> = {
  admin: "Admin",
  developer: "Developer",
  content_writer: "Content writer",
  client: "Client",
};

export function InviteDialog({ sites }: { sites: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<AppRole | "">("");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [success, setSuccess] = useState<InviteResult | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const { toast } = useToast();

  const [state, formAction, pending] = useActionState<InviteResult | undefined, FormData>(
    inviteUserAction,
    undefined,
  );
  // useActionState hands back a fresh object per run, so this fires once per
  // completed submission rather than once per render.
  const lastHandled = useRef<InviteResult | undefined>(undefined);

  useEffect(() => {
    if (!state || state === lastHandled.current) return;
    lastHandled.current = state;
    if (state.ok) {
      // The toast never carries the link — a toast body is exactly the kind
      // of place that can persist (in a log, in a screenshot) longer than
      // intended for a bearer credential. The link only ever appears in the
      // dialog body below.
      toast({ tone: "success", title: "Account created" });
      setSuccess(state);
      formRef.current?.reset();
      setRole("");
      setSiteIds([]);
    } else {
      toast({ tone: "error", title: "Invite failed", description: state.error });
    }
  }, [state, toast]);

  function openDialog() {
    setSuccess(null);
    setOpen(true);
  }

  function closeDialog() {
    setOpen(false);
    setSuccess(null);
    setRole("");
    setSiteIds([]);
    formRef.current?.reset();
  }

  function toggleSite(id: string) {
    setSiteIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  const needsSites = role === "client";
  const siteSelectionMissing = needsSites && siteIds.length === 0;
  const canSubmit = role !== "" && !siteSelectionMissing && !pending;

  return (
    <>
      <button type="button" onClick={openDialog} className={buttonClass("primary")}>
        <IconPlus size={16} />
        Invite person
      </button>

      <Modal
        open={open}
        onClose={closeDialog}
        title={success ? "Account created" : "Invite a person"}
        description={
          success
            ? undefined
            : "They will be created with the role you choose below. No email is sent — you'll get a link to send them yourself."
        }
      >
        {success ? (
          <div className="space-y-4 pb-5">
            {success.inviteLink ? (
              <>
                <p className="text-body text-ink">
                  Copy this link and send it to the recipient — the panel does not email it for
                  you. It is shown once, right now, and won&apos;t be shown again.
                </p>
                <div className="flex flex-col gap-2 rounded-2xl border border-hairline bg-canvas p-3 sm:flex-row sm:items-center">
                  <code className="min-w-0 flex-1 truncate text-caption tracking-normal text-ink">
                    {success.inviteLink}
                  </code>
                  {/* secret: this is a bearer credential — whoever holds it can claim the
                      account, so the toast must never echo it back (see docs/superpowers/
                      sdd/task-4-report.md, Fix round 1, Finding 1). */}
                  <CopyValueButton value={success.inviteLink} label="Copy link" secret />
                </div>
                <p className={hintClass}>
                  Whoever holds this link can claim the account — send it somewhere only the
                  recipient will see, not a shared or public channel.
                </p>
              </>
            ) : (
              <p className="flex items-start gap-2 text-body text-ember">
                <IconAlert size={16} className="mt-0.5 shrink-0" />
                The account was created, but no invite link came back. Ask them to use
                &quot;Forgot password&quot; on the sign-in page instead.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setSuccess(null)}
                className={buttonClass("secondary")}
              >
                Invite another
              </button>
              <button type="button" onClick={closeDialog} className={buttonClass("primary")}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form ref={formRef} action={formAction} className="space-y-4 pb-5">
            <div className="space-y-1.5">
              <label htmlFor="invite-email" className={labelClass}>
                Email
              </label>
              <input
                id="invite-email"
                name="email"
                type="email"
                required
                autoComplete="off"
                placeholder="person@example.com"
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="invite-role" className={labelClass}>
                Role
              </label>
              <select
                id="invite-role"
                name="role"
                required
                value={role}
                onChange={(e) => setRole(e.target.value as AppRole)}
                className={inputClass}
              >
                <option value="" disabled>
                  Select a role
                </option>
                {APP_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>

            {needsSites && (
              <fieldset className="space-y-1.5">
                <legend className={labelClass}>Sites</legend>
                {sites.length === 0 ? (
                  <p className={hintClass}>
                    No sites are connected yet — connect one before inviting a client.
                  </p>
                ) : (
                  <>
                    <div className="max-h-48 space-y-1 overflow-y-auto rounded-2xl border border-hairline p-3">
                      {sites.map((site) => (
                        <label
                          key={site.id}
                          className="flex min-h-8 cursor-pointer items-center gap-2 text-body text-ink"
                        >
                          <input
                            type="checkbox"
                            name="siteIds"
                            value={site.id}
                            checked={siteIds.includes(site.id)}
                            onChange={() => toggleSite(site.id)}
                            className="size-4 shrink-0 rounded-md accent-ink"
                          />
                          {site.name}
                        </label>
                      ))}
                    </div>
                    <p className={hintClass}>
                      A client with no sites granted has an empty dashboard — choose at least one.
                    </p>
                  </>
                )}
              </fieldset>
            )}

            <div aria-live="polite" className="min-h-5">
              {state && !state.ok && (
                <p className="flex items-start gap-2 text-body text-ember">
                  <IconAlert size={16} className="mt-0.5 shrink-0" />
                  {state.error}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={closeDialog} className={buttonClass("secondary")}>
                Cancel
              </button>
              <button type="submit" disabled={!canSubmit} className={buttonClass("primary")}>
                {pending && <IconSpinner size={16} />}
                {pending ? "Creating…" : "Create account"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
