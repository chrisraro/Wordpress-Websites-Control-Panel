import Link from "next/link";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { pendingUpdates } from "@/services/inventory/types";
import type { SiteStatus } from "@/services/sites/types";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<SiteStatus, string> = {
  connected: "bg-green-100 text-green-800",
  degraded: "bg-yellow-100 text-yellow-800",
  reconnect_needed: "bg-red-100 text-red-800",
  disabled: "bg-slate-200 text-slate-600",
};

export default async function DashboardPage() {
  const db = createServiceSupabase();
  const sites = await listSites({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient });
  const snapshots = supabaseSnapshotsRepo(db);
  const securityRepo = supabaseSecurityRepo(db);
  const updates = new Map<string, number>();
  const grades = new Map<string, string>();
  await Promise.all(sites.map(async (s) => {
    const snap = await snapshots.latestSnapshot(s.id);
    if (snap) updates.set(s.id, pendingUpdates(snap.payload));
    const g = await securityRepo.latestGrade(s.id);
    if (g) grades.set(s.id, g.grade);
  }));

  const seoRepo = supabaseSeoRepo(db);
  const seoScores = new Map<string, number>();
  await Promise.all(sites.map(async (s) => {
    const score = await seoRepo.latestAuditScore(s.id);
    if (score !== null) seoScores.set(s.id, score);
  }));

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <h1 className="mb-6 text-2xl font-semibold">Sites</h1>
      {sites.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-white p-12 text-center text-slate-500">
          No sites connected yet.{" "}
          <Link href="/sites/new" className="text-slate-900 underline">Connect your first site</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((s) => {
            const n = updates.get(s.id);
            return (
              <Link key={s.id} href={`/sites/${s.id}`}
                className="rounded-lg border bg-white p-4 shadow-sm transition hover:shadow">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-medium">{s.name}</h2>
                    <p className="truncate text-sm text-slate-500">{s.url.replace(/^https?:\/\//, "")}</p>
                  </div>
                  <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[s.status]}`}>
                    {s.status.replace("_", " ")}
                  </span>
                </div>
                <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>{s.capabilities?.abilities?.length ?? 0} abilities</span>
                  {s.client_label && <span>· {s.client_label}</span>}
                  {n !== undefined && (n > 0
                    ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">{n} updates</span>
                    : <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-800">up to date</span>)}
                  {grades.has(s.id) && (
                    <span className={`rounded-full px-2 py-0.5 ${
                      { A: "bg-green-100 text-green-800", B: "bg-lime-100 text-lime-800", C: "bg-amber-100 text-amber-800",
                        D: "bg-orange-100 text-orange-800", F: "bg-red-100 text-red-800" }[grades.get(s.id)!]
                    }`}>
                      security {grades.get(s.id)}
                    </span>
                  )}
                  {seoScores.has(s.id) && (
                    <span className={`rounded-full px-2 py-0.5 ${
                      seoScores.get(s.id)! >= 80 ? "bg-green-100 text-green-800"
                        : seoScores.get(s.id)! >= 50 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"
                    }`}>
                      SEO {seoScores.get(s.id)}
                    </span>
                  )}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
