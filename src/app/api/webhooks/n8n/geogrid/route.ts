import { NextResponse } from "next/server";
import { verifyN8nRequest } from "@/lib/n8n-auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { computeRetryDelayMs } from "@/services/jobs/service";
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
  // "running" is accepted too: n8n acks instantly and can call back before the
  // job has been parked. markAwaiting is guarded on status="running", so a
  // callback that wins the race is not overwritten.
  const open = job?.status === "awaiting_callback" || job?.status === "running";
  if (!job || job.type !== "geogrid_run" || !open) {
    return NextResponse.json({ ok: false, error: "no run awaiting this id" }, { status: 404 });
  }

  if (typeof body.error === "string" && body.error) {
    // n8n posts this only when no point at all could be measured (e.g. a
    // transient Serper timeout hit the whole run). That is retryable the same
    // way any other job failure is: back off on the normal ladder
    // (60s, then 300s) and only give up permanently once it's exhausted —
    // mirroring processJobs' own catch block in services/jobs/service.ts.
    const msg = `n8n reported: ${body.error}`;
    const delay = computeRetryDelayMs(job.attempts);
    if (delay === null) {
      await jobs.markFailed(runId, msg);
      return NextResponse.json({ ok: true, recorded: "error" });
    }
    await jobs.retry(runId, msg, new Date(Date.now() + delay).toISOString());
    return NextResponse.json({ ok: true, recorded: "retry" });
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
  // Wire contract: {run_id, ranks: [{idx, rank, measured}]}. `measured` is
  // optional and defaults to true — the current n8n workflow does not send it
  // yet, and every entry it does post is a real lookup. `measured: false`
  // means that point's lookup failed and its rank must be ignored even if one
  // was sent alongside it (a partial/stale value from n8n is not data).
  const byIdx = new Map<number, { rank: number | null; measured: boolean }>();
  for (const entry of Array.isArray(body.ranks) ? body.ranks : []) {
    const e = entry as { idx?: unknown; rank?: unknown; measured?: unknown };
    if (typeof e.idx !== "number") continue;
    const measured = typeof e.measured === "boolean" ? e.measured : true;
    const rank = measured && typeof e.rank === "number" && e.rank >= 1 && e.rank <= 20
      ? Math.round(e.rank)
      : null;
    byIdx.set(e.idx, { rank, measured });
  }
  // A grid point missing entirely from ranks[] is a point nobody reported —
  // that is "unmeasured", not "confirmed outside the top 20".
  const ranks: RankPoint[] = grid.map((p) => {
    const entry = byIdx.get(p.idx);
    return entry ? { ...p, rank: entry.rank, measured: entry.measured } : { ...p, rank: null, measured: false };
  });

  await completeGeoGridRun(geogrid, payload.config_id, payload.keyword, ranks);
  await jobs.markDone(runId);
  return NextResponse.json({ ok: true, points: ranks.length });
}
