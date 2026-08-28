import { NextResponse } from "next/server";
import { verifyN8nRequest } from "@/lib/n8n-auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { completeGeoGridRun } from "@/services/geogrid/run";
import { buildGrid } from "@/services/geogrid/grid";
import type { RankPoint } from "@/services/geogrid/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface CallbackBody {
  run_id?: unknown;
  ranks?: unknown;
  error?: unknown;
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyN8nRequest(raw, req.headers)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: CallbackBody;
  try {
    body = JSON.parse(raw) as CallbackBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const runId = typeof body.run_id === "string" ? body.run_id : null;
  if (!runId) return NextResponse.json({ ok: false, error: "run_id required" }, { status: 400 });

  const db = createServiceSupabase();
  const jobs = supabaseJobsRepo(db);
  const job = await jobs.getJob(runId);
  if (!job || job.type !== "geogrid_run" || job.status !== "awaiting_callback") {
    return NextResponse.json({ ok: false, error: "no run awaiting this id" }, { status: 404 });
  }

  if (typeof body.error === "string" && body.error) {
    await jobs.markFailed(runId, `n8n reported: ${body.error}`);
    return NextResponse.json({ ok: true, recorded: "error" });
  }

  const payload = job.payload as { config_id?: string; keyword?: string };
  if (!payload.config_id || !payload.keyword) {
    await jobs.markFailed(runId, "job payload malformed");
    return NextResponse.json({ ok: false, error: "job payload malformed" }, { status: 400 });
  }

  const geogrid = supabaseGeoGridRepo(db);
  const config = await geogrid.getConfig(payload.config_id);
  if (!config) {
    await jobs.markFailed(runId, "GeoGrid config no longer exists");
    return NextResponse.json({ ok: false, error: "config missing" }, { status: 404 });
  }

  // Coordinates come from our own config, not from the callback: n8n only
  // reports a rank per point index, so a hostile body cannot move the grid.
  const grid = buildGrid(config.center_lat, config.center_lng, config.grid_size, config.spacing_m);
  const byIdx = new Map<number, number | null>();
  for (const entry of Array.isArray(body.ranks) ? body.ranks : []) {
    const e = entry as { idx?: unknown; rank?: unknown };
    if (typeof e.idx !== "number") continue;
    const rank = typeof e.rank === "number" && e.rank >= 1 && e.rank <= 20 ? Math.round(e.rank) : null;
    byIdx.set(e.idx, rank);
  }
  const ranks: RankPoint[] = grid.map((p) => ({ ...p, rank: byIdx.get(p.idx) ?? null }));

  await completeGeoGridRun(geogrid, payload.config_id, payload.keyword, ranks);
  await jobs.markDone(runId);
  return NextResponse.json({ ok: true, points: ranks.length });
}
