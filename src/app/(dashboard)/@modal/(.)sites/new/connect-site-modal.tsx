"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { ConnectSiteForm } from "@/app/(dashboard)/sites/new/connect-site-form";
import { resolveCloseDestination } from "./resolve-close-destination";

/**
 * The modal shell for the intercepted /sites/new route. Renders the same
 * ConnectSiteForm the full page uses (src/app/(dashboard)/sites/new/new-site-form.tsx)
 * inside the shared Modal component instead of page chrome -- Modal already
 * supplies the title and card surface.
 */
export function ConnectSiteModal() {
  const router = useRouter();
  const [open, setOpen] = useState(true);

  const close = useCallback(() => {
    setOpen(false);
    const destination = resolveCloseDestination(window.history.length);
    if (destination === "back") {
      router.back();
    } else {
      router.replace("/dashboard");
    }
  }, [router]);

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
