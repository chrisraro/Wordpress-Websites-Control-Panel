import Link from "next/link";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import type { SiteStatus } from "@/services/sites/types";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<SiteStatus, string> = {
  connected: "bg-green-100 text-green-800",
  degraded: "bg-yellow-100 text-yellow-800",
  reconnect_needed: "bg-red-100 text-red-800",
  disabled: "bg-slate-200 text-slate-600",
};

export default async function DashboardPage() {
  const repo = supabaseSitesRepo(createServiceSupabase());
  const sites = await listSites({ repo, mcp: createSiteMcpClient });

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">Sites</h1>
      {sites.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-white p-12 text-center text-slate-500">
          No sites connected yet.{" "}
          <Link href="/sites/new" className="text-slate-900 underline">Connect your first site</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((s) => (
            <Link key={s.id} href={`/sites/${s.id}`}
              className="rounded-lg border bg-white p-4 shadow-sm transition hover:shadow">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-medium">{s.name}</h2>
                  <p className="text-sm text-slate-500">{s.url.replace(/^https?:\/\//, "")}</p>
                </div>
                <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[s.status]}`}>
                  {s.status.replace("_", " ")}
                </span>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                {s.capabilities?.abilities?.length ?? 0} abilities
                {s.client_label ? ` · ${s.client_label}` : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
