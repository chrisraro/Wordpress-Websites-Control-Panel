import Link from "next/link";
import { listSitesForViewer } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { requireViewer } from "@/lib/authz/server";
import { readDbFor } from "@/lib/authz/db";
import { supabaseSnapshotsRepo } from "@/services/inventory/repo";
import { supabaseSecurityRepo } from "@/services/security/repo";
import { supabaseSeoRepo } from "@/services/seo/repo";
import { pendingUpdates } from "@/services/inventory/types";
import type { SiteStatus } from "@/services/sites/types";
import { Card, EmptyState, PageHeader, StatusBadge, type StatusTone } from "@/components/ui/primitives";
import { buttonClass, cardClass } from "@/components/ui/styles";
import { IconPlus, IconSites } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<SiteStatus, StatusTone> = {
  connected: "good",
  degraded: "warn",
  reconnect_needed: "bad",
  disabled: "idle",
};

const GRADE_TONE: Record<string, StatusTone> = {
  A: "good", B: "good", C: "warn", D: "alert", F: "bad",
};

function seoTone(score: number): StatusTone {
  return score >= 80 ? "good" : score >= 50 ? "warn" : "bad";
}

export default async function DashboardPage() {
  const viewer = await requireViewer();
  const db = await readDbFor(viewer);
  const sites = await listSitesForViewer({ repo: supabaseSitesRepo(db), mcp: createSiteMcpClient }, viewer);
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
    <main>
      <PageHeader
        title="Sites"
        subtitle={
          sites.length > 0
            ? `${sites.length} WordPress ${sites.length === 1 ? "site" : "sites"} connected`
            : undefined
        }
        actions={
          sites.length > 0 && (
            <Link href="/sites/new" className={buttonClass("primary")}>
              <IconPlus size={16} />
              Connect site
            </Link>
          )
        }
      />

      {sites.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconSites size={28} />}
            title="No sites connected yet"
            action={
              <Link href="/sites/new" className={`${buttonClass("primary")} mt-1`}>
                <IconPlus size={16} />
                Connect your first site
              </Link>
            }
          >
            Connect a WordPress site running the Novamira plugin to manage its plugins and
            themes, scan it for vulnerabilities, and report on its search visibility.
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sites.map((s) => {
            const n = updates.get(s.id);
            const grade = grades.get(s.id);
            const seo = seoScores.get(s.id);
            return (
              <li key={s.id}>
                <Link
                  href={`/sites/${s.id}`}
                  className={`${cardClass} flex h-full flex-col p-5 transition-[box-shadow,transform]
                    duration-200 ease-[var(--ease-out-quint)] hover:-translate-y-0.5
                    hover:shadow-raised focus-visible:-translate-y-0.5`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-body font-medium text-ink">{s.name}</h2>
                      <p className="truncate text-caption tracking-normal text-mid-gray">
                        {s.url.replace(/^https?:\/\//, "")}
                      </p>
                    </div>
                    <StatusBadge tone={STATUS_TONE[s.status]} className="shrink-0">
                      {s.status.replace("_", " ")}
                    </StatusBadge>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-1.5">
                    {n !== undefined &&
                      (n > 0 ? (
                        <StatusBadge tone="warn">{n} updates</StatusBadge>
                      ) : (
                        <StatusBadge tone="good">Up to date</StatusBadge>
                      ))}
                    {grade && (
                      <StatusBadge tone={GRADE_TONE[grade] ?? "idle"}>Security {grade}</StatusBadge>
                    )}
                    {seo !== undefined && (
                      <StatusBadge tone={seoTone(seo)}>SEO {seo}</StatusBadge>
                    )}
                  </div>

                  <p className="mt-4 flex flex-wrap items-center gap-x-2 text-caption tracking-normal text-mid-gray">
                    <span>{s.capabilities?.abilities?.length ?? 0} abilities</span>
                    {s.client_label && <span>· {s.client_label}</span>}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
