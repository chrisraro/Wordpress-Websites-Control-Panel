import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { cardClass } from "@/components/ui/styles";
import { ConnectSiteForm } from "./connect-site-form";

/**
 * Page chrome for /sites/new: breadcrumbs, heading, intro copy, and the card
 * surface around the form. Kept separate from ConnectSiteForm because none
 * of this belongs inside the intercepting modal, which already supplies a
 * title and a card surface of its own (src/components/ui/modal.tsx).
 */
export function NewSiteForm() {
  return (
    <main className="mx-auto max-w-xl">
      <Breadcrumbs items={[{ label: "Sites", href: "/dashboard" }, { label: "Connect a site" }]} />

      <h1 className="text-heading-sm font-semibold text-ink">Connect a WordPress site</h1>
      <p className="mt-1 text-body text-mid-gray">
        We verify the connection before saving, so you will know immediately if the credentials
        or the Novamira plugin need attention.
      </p>

      <div className={`${cardClass} mt-6 p-5`}>
        <ConnectSiteForm />
      </div>
    </main>
  );
}
