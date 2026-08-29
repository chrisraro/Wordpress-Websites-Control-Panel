import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/authz/server";
import { isUuidShaped } from "@/lib/uuid";
import { BatchPoller } from "./poller";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("wp_toolkit.manage");
  if (!isUuidShaped(id)) notFound();
  return (
    <main>
      <Breadcrumbs
        items={[{ label: "Marketplace", href: "/marketplace" }, { label: "Batch" }]}
      />
      <h1 className="text-heading-sm font-semibold text-ink">Batch</h1>
      <p className="mb-6 mt-1 break-all text-caption tracking-normal text-mid-gray">{id}</p>
      <BatchPoller batchId={id} />
    </main>
  );
}
