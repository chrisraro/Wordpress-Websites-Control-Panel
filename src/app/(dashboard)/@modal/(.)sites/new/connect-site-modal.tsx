"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { ConnectSiteForm } from "@/app/(dashboard)/sites/new/connect-site-form";
import { resolveCloseDestination } from "./resolve-close-destination";

/**
 * The modal shell for the intercepted /sites/new route. Renders the same
 * ConnectSiteForm the full page uses (src/app/(dashboard)/sites/new/new-site-form.tsx)
 * inside the shared Modal component instead of page chrome -- Modal already
 * supplies the title and card surface.
 *
 * Whether the modal is open is derived from the route rather than held as a
 * one-way boolean: it is open while the URL is /sites/new and the user has not
 * asked to close it *on this visit*. `closedOn` records the pathname the close
 * was requested on and is cleared as soon as the pathname moves on, so if this
 * instance survives a navigation (a parallel slot can keep its previous tree
 * on a soft navigation), clicking "Connect site" again still reopens it
 * instead of leaving a permanently closed dialog behind.
 */
export function ConnectSiteModal() {
  const router = useRouter();
  const pathname = usePathname();
  const [closedOn, setClosedOn] = useState<string | null>(null);

  // Reset during render (React's "adjust state when a prop changes" pattern)
  // rather than in an effect, so no frame renders a stale close over a
  // freshly reopened modal.
  if (closedOn !== null && closedOn !== pathname) {
    setClosedOn(null);
  }

  const open = pathname === "/sites/new" && closedOn !== pathname;

  const close = useCallback(() => {
    setClosedOn(pathname);
    const destination = resolveCloseDestination(window.history.length);
    if (destination === "back") {
      router.back();
    } else {
      router.replace("/dashboard");
    }
  }, [router, pathname]);

  return (
    <Modal
      open={open}
      onClose={close}
      title="Connect a WordPress site"
      description="We verify the connection before saving, so you will know immediately if the credentials or the Novamira plugin need attention."
    >
      <ConnectSiteForm />
    </Modal>
  );
}
