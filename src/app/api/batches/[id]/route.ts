import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { getViewer } from "@/lib/authz/server";
import { visibleSiteIds } from "@/lib/authz/decide";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseSitesRepo } from "@/services/sites/repo";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  // getViewer(), not requireViewer(): the latter calls next/navigation's
  // notFound(), which is meant for page renders and is not a supported way
  // to produce a 404 Response from a bare Route Handler. Route handlers
  // reply with an explicit NextResponse instead.
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { id } = await ctx.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "invalid batch id" }, { status: 400 });
  }
  const db = createServiceSupabase();
  const [jobs, sites] = await Promise.all([
    supabaseJobsRepo(db).batchJobs(id),
    supabaseSitesRepo(db).listSites(),
  ]);

  // A batch's jobs may span sites the caller cannot see. Filter to visible
  // sites before anything about the batch — including site names — reaches
  // the response. If nothing remains, 404 rather than an empty list: an
  // empty `jobs: []` with `done: true` would still confirm the batch id
  // exists to someone who should not know that.
  const visible = visibleSiteIds(viewer, sites.map((s) => s.id));
  const visibleJobs = visible === "all" ? jobs : jobs.filter((j) => j.site_id && visible.includes(j.site_id));
  if (visibleJobs.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const names = new Map(sites.map((s) => [s.id, s.name]));
  const rows = visibleJobs.map((j) => {
    const siteName = j.site_id ? names.get(j.site_id) ?? j.site_id : "—";
    const payload = j.payload as { label?: unknown; kind?: unknown; target?: unknown; activate?: unknown };
    const payloadLabel = payload.label;
    return {
      id: j.id,
      site_id: j.site_id,
      site_name: siteName,
      // Bulk batches are one site, many items; install batches are one item,
      // many sites. The payload label distinguishes them.
      label: typeof payloadLabel === "string" && payloadLabel ? payloadLabel : siteName,
      status: j.status,
      attempts: j.attempts,
      last_error: j.last_error,
      // `type` ("plugin_install" vs "bulk_manage") plus this non-secret bulk
      // metadata is what lets the batch page describe what is actually
      // happening instead of hardcoding "install" for every batch shape —
      // see src/app/(dashboard)/marketplace/batches/[id]/poller.tsx.
      type: j.type,
      kind: typeof payload.kind === "string" ? payload.kind : undefined,
      target: typeof payload.target === "string" ? payload.target : undefined,
      activate: typeof payload.activate === "boolean" ? payload.activate : undefined,
    };
  });
  const done = rows.length > 0 && rows.every((r) => r.status === "done" || r.status === "failed");
  return NextResponse.json({ jobs: rows, done });
}
