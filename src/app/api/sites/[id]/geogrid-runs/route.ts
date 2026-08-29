import { NextResponse } from "next/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { getViewer } from "@/lib/authz/server";
import { canAccessSite } from "@/lib/authz/decide";
import { isUuidShaped } from "@/lib/uuid";
import { allSettled } from "@/services/jobs/service";
import type { JobStatus } from "@/services/jobs/types";

export const dynamic = "force-dynamic";

interface RunRow {
  id: string;
  status: JobStatus;
  payload: Record<string, unknown> | null;
  last_error: string | null;
}

/**
 * Backs the GeoGrid tab's live poller (../../../sites/[id]/geogrid/run-poller.tsx).
 * A GeoGrid run is dispatched to n8n and the callback lands minutes later, so
 * this is polled on a slow interval — see POLL_MS in that component for why.
 *
 * getViewer(), not requireSiteAccess(): a Route Handler's notFound() renders
 * an empty body, which would break this route's JSON contract with the
 * poller that consumes it (see src/app/api/batches/[id]/route.ts, which
 * makes the same call for the same reason). The response is written out
 * explicitly instead, 404-ing "no such site" and "not yours to see"
 * identically so a client can never distinguish the two.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { id } = await ctx.params;
  if (!isUuidShaped(id)) {
    return NextResponse.json({ error: "invalid site id" }, { status: 400 });
  }
  // Same gate the page itself uses (requireSiteAccess default is "read") —
  // a client with no grant on this site must get exactly the same 404 as a
  // site id that does not exist at all.
  if (!canAccessSite(viewer, id, "read")) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const db = createServiceSupabase();
  // Mirrors the GeoGrid page's own "in progress" query (see
  // src/app/(dashboard)/sites/[id]/geogrid/page.tsx) so this route's "is
  // anything open" can never disagree with what the page itself shows.
  const { data, error } = await db
    .from("jobs")
    .select("id,status,payload,last_error")
    .eq("site_id", id)
    .eq("type", "geogrid_run")
    .order("scheduled_for", { ascending: false })
    .limit(20);
  if (error) {
    return NextResponse.json({ error: "failed to load runs" }, { status: 500 });
  }

  const rows = (data ?? []) as RunRow[];
  // Only what the poller needs to decide "still running / finished / failed"
  // and to describe the outcome in a toast: no config id, no site details
  // beyond what the page already renders, no credentials.
  const jobs = rows.map((r) => {
    const payload = (r.payload ?? {}) as { keyword?: unknown };
    return {
      id: r.id,
      status: r.status,
      keyword: typeof payload.keyword === "string" ? payload.keyword : "",
      last_error: r.last_error,
    };
  });
  return NextResponse.json({ jobs, done: allSettled(rows) });
}
