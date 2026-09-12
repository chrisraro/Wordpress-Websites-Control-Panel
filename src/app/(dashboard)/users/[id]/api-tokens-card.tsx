"use client";

/**
 * API tokens for one account: create (self only) + the list + a connect
 * snippet, per docs/superpowers/specs/2026-09-12-panel-mcp-server-design.md
 * §Token management UI.
 *
 * `mode` is the only thing that changes between the two places this card
 * renders:
 *
 * - "self" on /account (the signed-in user's own page): create form, list,
 *   connect snippet. createTokenAction's own first check refuses a mint for
 *   anyone but the caller, so this mode is not itself the enforcement -- it
 *   just doesn't offer a control the server would refuse anyway.
 * - "admin" on /users/[id] (a users.manage holder looking at someone else):
 *   list + revoke only, plus a note explaining why there's no create form
 *   here. A token is an impersonation of its owner -- minting one for
 *   somebody else would let an admin act as them with nothing in the audit
 *   trail to show it was not really them -- so this form is never offered,
 *   on principle, not just because the viewer lacks a permission.
 *
 * Revoke is available in both modes: a user revokes their own, and
 * users.manage can revoke anyone's (token-actions.ts enforces this
 * regardless of which page called it).
 */
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTokenAction, revokeTokenAction } from "./token-actions";
import { CopyValueButton } from "@/components/ui/copy-button";
import { ConfirmDialog } from "@/components/ui/modal";
import { StatusBadge, type StatusTone } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { buttonClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconInfo, IconSpinner } from "@/components/ui/icons";
import type { ApiTokenRow } from "@/services/tokens/types";

type CreateState = { ok: boolean; secret?: string; error?: string };

function tokenStatus(t: ApiTokenRow): { label: string; tone: StatusTone } {
  if (t.revoked_at) return { label: "Revoked", tone: "bad" };
  if (t.expires_at && new Date(t.expires_at).getTime() < Date.now()) {
    return { label: "Expired", tone: "bad" };
  }
  return { label: "Active", tone: "good" };
}

export function ApiTokensCard({
  mode, userId, tokens, tokensUnavailable = false,
}: {
  mode: "self" | "admin";
  userId: string;
  tokens: ApiTokenRow[];
  /** True when the page could not read api_tokens at all (migration 0021
   * has not been applied yet) -- see listTokensOrUnavailable. The list is
   * replaced by a one-line hint; nothing else on the page is affected. */
  tokensUnavailable?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenRow | null>(null);
  const [revokePending, startRevoke] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Only ever set client-side, from the browser's own location -- this is a
  // display placeholder, never a real credential, so there is nothing to
  // protect by delaying it. Kept in state (rather than read inline) so the
  // server-rendered markup and the first client render agree before
  // hydration swaps in the real origin.
  const [appUrl, setAppUrl] = useState("");

  useEffect(() => {
    setAppUrl(window.location.origin);
  }, []);

  const [state, formAction, formPending] = useActionState<CreateState | null, FormData>(
    createTokenAction.bind(null, userId),
    null,
  );
  // useActionState hands back a fresh object per run, so this fires once per
  // completed submission rather than once per render.
  const lastHandled = useRef<CreateState | null>(null);

  useEffect(() => {
    if (!state || state === lastHandled.current) return;
    lastHandled.current = state;
    if (state.ok) {
      // The toast never carries the secret -- same reasoning as the invite
      // dialog's link: a toast lives ~4.5s outside whatever the admin is
      // actually looking at, which is exactly the wrong place for a bearer
      // credential to sit even briefly. The secret only ever appears in the
      // copy box below.
      toast({ tone: "success", title: "Token created" });
      formRef.current?.reset();
      setReadOnly(false);
      router.refresh();
    } else if (state.error) {
      toast({ tone: "error", title: "Could not create token", description: state.error });
    }
  }, [state, toast, router]);

  function handleRevoke(tokenId: string) {
    // Close the dialog immediately and show the pending state on the row's
    // own button instead -- the same sequencing plugin-table.tsx's bulk
    // confirm uses, so a slow request doesn't leave the confirmation dialog
    // sitting open indefinitely.
    setRevokeTarget(null);
    setBusyId(tokenId);
    startRevoke(async () => {
      const result = await revokeTokenAction(tokenId);
      setBusyId(null);
      if (result.ok) {
        toast({ tone: "success", title: "Token revoked" });
        router.refresh();
      } else {
        toast({ tone: "error", title: "Could not revoke token", description: result.error });
      }
    });
  }

  return (
    <div className="space-y-5">
      {mode === "self" ? (
        <form ref={formRef} action={formAction} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="token-name" className={labelClass}>
                Name
              </label>
              <input
                id="token-name"
                name="name"
                type="text"
                required
                maxLength={80}
                autoComplete="off"
                placeholder="Claude Code"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="token-expiry" className={labelClass}>
                Expiry
              </label>
              <select id="token-expiry" name="expiry" defaultValue="30d" className={inputClass}>
                <option value="none">No expiry</option>
                <option value="30d">30 days</option>
                <option value="90d">90 days</option>
                <option value="1y">1 year</option>
              </select>
            </div>
          </div>

          <label className="flex min-h-8 cursor-pointer items-start gap-2 text-body text-ink">
            <input
              type="checkbox"
              name="read_only"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 rounded-md accent-ink"
            />
            Read-only (can list and inspect, cannot change anything)
          </label>

          <div aria-live="polite" className="min-h-5">
            {state && !state.ok && state.error && (
              <p className="flex items-start gap-2 text-body text-ember">
                <IconAlert size={16} className="mt-0.5 shrink-0" />
                {state.error}
              </p>
            )}
          </div>

          <div className="flex justify-end">
            <button type="submit" disabled={formPending} className={buttonClass("primary")}>
              {formPending && <IconSpinner size={16} />}
              {formPending ? "Creating…" : "Create token"}
            </button>
          </div>
        </form>
      ) : (
        <p className={`flex items-start gap-2 ${hintClass}`}>
          <IconInfo size={16} className="mt-0.5 shrink-0" />
          Tokens can only be created by their owner, from their own Account page — nobody can
          mint a token on someone else&apos;s behalf.
        </p>
      )}

      {state?.ok && state.secret && (
        <div className="space-y-2 rounded-2xl border border-hairline bg-canvas p-3">
          <p className="text-body text-ink">
            <span className="font-semibold">This will not be shown again.</span> Copy it now and
            store it somewhere safe.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all font-mono text-caption tracking-normal text-ink">
              {state.secret}
            </code>
            {/* secret: a bearer credential -- see the invite dialog for the
                same reasoning (tests/copy-button-secret.test.ts pins it). */}
            <CopyValueButton value={state.secret} label="Copy token" secret />
          </div>
        </div>
      )}

      {tokensUnavailable ? (
        <p className={`flex items-start gap-2 ${hintClass}`}>
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            API tokens are unavailable — the{" "}
            <code className="font-mono">api_tokens</code> migration has not been applied.
          </span>
        </p>
      ) : tokens.length === 0 ? (
        <p className={hintClass}>No API tokens yet.</p>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-3xl border border-hairline">
          {tokens.map((t) => {
            const status = tokenStatus(t);
            const revoking = revokePending && busyId === t.id;
            return (
              <li
                key={t.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-body font-medium text-ink">{t.name}</p>
                  <p className="mt-0.5 text-caption tracking-normal text-mid-gray">
                    <span className="font-mono">{t.token_prefix}…</span> · created{" "}
                    {new Date(t.created_at).toLocaleDateString()} · last used{" "}
                    {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "never"}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    {t.read_only && <StatusBadge tone="idle">Read-only</StatusBadge>}
                  </div>
                </div>
                {!t.revoked_at && (
                  <button
                    type="button"
                    onClick={() => setRevokeTarget(t)}
                    disabled={revoking}
                    aria-label={`Revoke ${t.name}`}
                    className={buttonClass("danger", "sm")}
                  >
                    {revoking && <IconSpinner size={14} />}
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-1.5 rounded-2xl border border-hairline bg-canvas p-3">
        <p className={labelClass}>Connect</p>
        <p className={hintClass}>
          Use a token you&apos;ve copied in place of the placeholder below.
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-caption tracking-normal text-ink">
          {`claude mcp add --transport http wp-control-panel ${appUrl}/api/mcp \\\n  --header "Authorization: Bearer <your token>"`}
        </pre>
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        title={`Revoke "${revokeTarget?.name ?? ""}"?`}
        description="Anything using this token stops working immediately. This cannot be undone."
        confirmLabel="Revoke token"
        tone="danger"
        onConfirm={() => revokeTarget && handleRevoke(revokeTarget.id)}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}
