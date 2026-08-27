import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchPoller } from "./poller";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Install batch</h1>
        <Link href="/marketplace" className="min-h-10 rounded border px-3 py-2 text-sm hover:bg-slate-100">
          ← Marketplace
        </Link>
      </div>
      <p className="mb-6 break-all text-xs text-slate-400">{id}</p>
      <BatchPoller batchId={id} />
    </main>
  );
}
