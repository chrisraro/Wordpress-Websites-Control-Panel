"use client";

/**
 * The danger control for this page: delete the account outright.
 *
 * `verdict` is computed on the server (page.tsx) from `canDeleteUser`
 * against a freshly read user list, and crosses the boundary as a plain
 * { allowed, reason } -- never the guard function or the user list. A
 * refusal (the last admin, or deleting your own account) keeps the control
 * visible and disabled with its reason rather than hiding it.
 *
 * Deletion removes the account this page is keyed to, so on success this
 * leaves for the directory immediately rather than lingering on a page
 * about an account that no longer exists.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteUserAction } from "../actions";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { buttonClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";

export function DeleteAccountForm({
  userId, email, verdict,
}: {
  userId: string;
  email: string | null;
  verdict: { allowed: boolean; reason?: string };
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const result = await deleteUserAction(userId);
      if (result.ok) {
        toast({ tone: "success", title: "Account deleted" });
        router.push("/users");
      } else {
        toast({ tone: "error", title: "Could not delete the account", description: result.error });
      }
    });
  }

  if (!verdict.allowed) {
    return (
      <p className="flex items-start gap-2 text-body text-ember">
        <IconAlert size={16} className="mt-0.5 shrink-0" />
        {verdict.reason}
      </p>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending}
        className={buttonClass("danger")}
      >
        {pending && <IconSpinner size={16} />}
        {pending ? "Deleting…" : "Delete account"}
      </button>

      <ConfirmDialog
        open={open}
        title={`Delete ${email ?? "this account"}?`}
        description="This permanently removes their ability to sign in and deletes their role and site grants. This cannot be undone."
        confirmLabel="Delete account"
        tone="danger"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          submit();
        }}
      />
    </>
  );
}
