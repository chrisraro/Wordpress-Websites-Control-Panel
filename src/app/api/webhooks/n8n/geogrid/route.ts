import { NextResponse } from "next/server";
import { verifyN8nRequest } from "@/lib/n8n-auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { computeRetryDelayMs } from "@/services/jobs/service";
import { supabaseGeoGridRepo } from "@/services/geogrid/repo";
import { completeGeoGridRun } from "@/services/geogrid/run";
import { buildGrid } from "@/services/geogrid/grid";
import { measuredCount, type RankPoint } from "@/services/geogrid/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface CallbackBody {
  run_id?: unknown;
  ranks?: unknown;
  error?: unknown;
}

/**
 * `run_id` is dispatched as `${jobId}:${attempt}` (see services/geogrid/run.ts)
 * so a callback can be tied to the specific attempt that produced it, not
 * just the job. A bare id with no `:attempt` suffix is accepted as
 * attempt-agnostic — that is what runs dispatched by older code (before this
 * suffix existed) still send, and they must keep landing.
 */
function parseRunId(raw: string): { jobId: string; attempt: number | null } {
  const i = raw.lastIndexOf(":");
  if (i === -1) return { jobId: raw, attempt: null };
  const attemptPart = raw.slice(i + 1);
  if (!/^\d+$/.test(attemptPart)) return { jobId: raw, attempt: null };
  return { jobId: raw.slice(0, i), attempt: Number(attemptPart) };
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
  const rawRunId = typeof body.run_id === "string" ? body.run_id : null;
  if (!rawRunId) return NextResponse.json({ ok: false, error: "run_id required" }, { status: 400 });
  const { jobId, attempt } = parseRunId(rawRunId);

  const db = createServiceSupabase();
  const jobs = supabaseJobsRepo(db);
  const job = await jobs.getJob(jobId);
  // "running" is accepted too: n8n acks instantly and can call back before the
  // job has been parked. markAwaiting is guarded on status="running", so a
  // callback that wins the race is not overwritten.
  const open = job?.status === "awaiting_callback" || job?.status === "running";
  if (!job || job.type !== "geogrid_run" || !open) {
    return NextResponse.json({ ok: false, error: "no run awaiting this id" }, { status: 404 });
  }
  // A callback from a superseded attempt (e.g. a late HTTP retry from an
  // execution that was itself already retried by the job ladder) must not be
  // allowed to complete or fail a job that has since moved on to a newer
  // attempt — that races a fresh dispatch and can overwrite its result or
  // double-count Serper spend. See fix/geogrid-partial-runs review, item 6.
  if (attempt !== null && attempt !== job.attempts) {
    return NextResponse.json({ ok: false, error: "stale attempt" }, { status: 404 });
  }

  const hasRanks = Array.isArray(body.ranks) && body.ranks.length > 0;
  if (!hasRanks && typeof body.error === "string" && body.error) {
    // n8n posts `error` only when no point at all could be measured (e.g. a
    // transient Serper timeout hit the whole run) — never alongside a usable
    // `ranks[]`. `hasRanks` defends that contract: a body carrying both is
    // treated as the partial result it is, not discarded wholesale.
    // The error itself is retryable the same way any other job failure is:
    // back off on the normal ladder (60s, then 300s) and only give up
    // permanently once it's exhausted — mirroring processJobs' own catch
    // block in services/jobs/service.ts.
    const msg = `n8n reported: ${body.error}`;
    const delay = computeRetryDelayMs(job.attempts);
    if (delay === null) {
      await jobs.markFailed(jobId, msg);
      return NextResponse.json({ ok: true, recorded: "error" });
    }
    await jobs.retry(jobId, msg, new Date(Date.now() + delay).toISOString());
    return NextResponse.json({ ok: true, recorded: "retry" });
  }

  const payload = job.payload as { config_id?: string; keyword?: string };
  if (!payload.config_id || !payload.keyword) {
    await jobs.markFailed(jobId, "job payload malformed");
    return NextResponse.json({ ok: false, error: "job payload malformed" }, { status: 400 });
  }

  const geogrid = supabaseGeoGridRepo(db);
  const config = await geogrid.getConfig(payload.config_id);
  if (!config) {
    await jobs.markFailed(jobId, "GeoGrid config no longer exists");
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
  //
  // Only *absent* means measured: n8n Set/Code nodes routinely stringify
  // booleans, so a strict `=== true` check (rather than `!== false`) is the
  // only direction that fails safe against `measured: "false"` — the unsafe
  // alternative silently promotes an unmeasured point to "confirmed doesn't
  // rank".
  const byIdx = new Map<number, { rank: number | null; measured: boolean }>();
  for (const entry of Array.isArray(body.ranks) ? body.ranks : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { idx?: unknown; rank?: unknown; measured?: unknown };
    if (typeof e.idx !== "number") continue;
    // A duplicate idx keeps its first entry; a later duplicate (e.g. a
    // trailing `{idx, measured:false}` appended after the real measurement)
    // is ignored rather than silently overwriting a good result.
    if (byIdx.has(e.idx)) continue;
    const measured = e.measured === undefined ? true : e.measured === true;
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

  // `hasRanks` above only checks that ranks[] is non-empty, not that any of
  // it is real data. A whole-run outage reported per-point (the shape the
  // n8n workflow's per-point error handling produces, e.g.
  // {error: "quota exceeded", ranks: [81 x {idx, measured:false}]} — or the
  // same with no top-level `error` at all) would otherwise take the success
  // path below: a snapshot with zero measured points, `markDone`, no retry,
  // no failed-run alert. Route a zero-measured body through the same retry
  // ladder as an explicit total-failure `error` with no ranks, regardless of
  // which shape n8n sent it in.
  if (typeof body.error === "string" && body.error) {
    // Discarded otherwise: a body carrying both `ranks` and `error` never
    // reaches the early "no ranks" branch above, so without this the reason
    // a lookup failed is unrecoverable even though ranks[] shows the damage.
    console.error(`GeoGrid callback for job ${jobId} included error alongside ranks: ${body.error}`);
  }
  if (grid.length > 0 && measuredCount(ranks) === 0) {
    const msg = typeof body.error === "string" && body.error
      ? `n8n reported: ${body.error}`
      : `n8n posted ${ranks.length} point(s), none measured`;
    const delay = computeRetryDelayMs(job.attempts);
    if (delay === null) {
      await jobs.markFailed(jobId, msg);
      return NextResponse.json({ ok: true, recorded: "error" });
    }
    await jobs.retry(jobId, msg, new Date(Date.now() + delay).toISOString());
    return NextResponse.json({ ok: true, recorded: "retry" });
  }

  await completeGeoGridRun(geogrid, payload.config_id, payload.keyword, ranks);
  await jobs.markDone(jobId);
  return NextResponse.json({ ok: true, points: ranks.length });
}
