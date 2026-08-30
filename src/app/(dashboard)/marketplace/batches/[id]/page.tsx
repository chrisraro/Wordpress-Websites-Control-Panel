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
      {/* The <h1> is rendered by BatchPoller, which is the only thing that
          knows what this batch actually did. The id moves to the foot of the
          page: it matters when quoting a job to someone, never when reading
          what happened. */}
      <BatchPoller batchId={id} />
      <p className="mt-6 break-all text-caption tracking-normal text-mid-gray">Batch {id}</p>
    </main>
  );
}
