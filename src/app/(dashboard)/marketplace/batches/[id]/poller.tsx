"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { processQueueNowAction } from "../../../queue-actions";
import { useToast } from "@/components/ui/toast";
import { Card, Skeleton, StatusBadge, type StatusTone } from "@/components/ui/primitives";
import { buttonClass, tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconSpinner } from "@/components/ui/icons";

interface BatchJob {
  id: string; site_id: string | null; site_name: string; label: string;
  status: string; attempts: number; last_error: string | null;
  type: string; kind?: string; target?: string; activate?: boolean;
}

const STATUS_TONE: Record<string, StatusTone> = {
  pending: "idle",
  running: "info",
  awaiting_callback: "info",
  done: "good",
  failed: "bad",
};

const BULK_VERB: Record<string, string> = {
  update: "Updating",
  activate: "Activating",
  deactivate: "Deactivating",
  delete: "Deleting",
};

/**
 * This page renders two different batch shapes: `plugin_install` jobs fan one
 * install out across many sites, `bulk_manage` jobs fan many bulk actions
 * (update/activate/deactivate/delete) out across one site's items. Neither
 * the heading nor the completion toast may assert "install" for a batch that
 * deleted things — that inaccuracy is exactly what this function exists to
 * prevent. Every job in one batch shares the same kind/target, so the first
 * row is representative of the whole batch.
 */
function describeBatch(jobs: BatchJob[]): string {
  const first = jobs[0];
  if (!first) return "Batch";
  // "plugin(s)" is a schema string, not a sentence. The count is known here.
  const kind = first.target === "theme" ? "theme" : "plugin";
  const noun = `${jobs.length} ${kind}${jobs.length === 1 ? "" : "s"}`;
  if (first.type === "bulk_manage") {
    const verb = BULK_VERB[first.kind ?? ""] ?? "Running";
    return `${verb} ${noun}`;
  }
  // plugin_install (including legacy jobs queued before `target` existed).
  return first.activate ? `Installing and activating ${noun}` : `Installing ${noun}`;
}

export function BatchPoller({ batchId }: { batchId: string }) {
  const [jobs, setJobs] = useState<BatchJob[] | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();
  const announced = useRef(false);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch(`/api/batches/${batchId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { jobs: BatchJob[]; done: boolean };
        if (stop) return;
        setJobs(data.jobs);
        setDone(data.done);
        setError(null);
        if (!data.done) timer = setTimeout(poll, 4000);
      } catch (e) {
        if (stop) return;
        setError(e instanceof Error ? e.message : "Polling failed");
        timer = setTimeout(poll, 8000);
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [batchId]);

  // Announce completion once — the user may have looked away for minutes.
  useEffect(() => {
    if (!done || !jobs || announced.current) return;
    announced.current = true;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const ok = jobs.filter((j) => j.status === "done").length;
    toast(
      failed > 0
        ? {
            tone: "error",
            title: "Batch finished with failures",
            description: `${ok} succeeded, ${failed} failed. Reasons are in the table.`,
          }
        // Neutral on purpose: this batch could be an install, an update, or a
        // delete, and the toast must be correct for all of them — see
        // describeBatch() above.
        : { tone: "success", title: "Batch complete", description: `${ok} of ${jobs.length} item${jobs.length === 1 ? "" : "s"} finished.` },
    );
  }, [done, jobs, toast]);

  const processNow = () => {
    startTransition(async () => {
      await processQueueNowAction();
    });
  };

  if (!jobs) {
    return (
      <>
        <Skeleton className="mb-6 h-8 w-64" />
      <Card className="overflow-hidden">
        <div className="space-y-3 p-5" aria-label="Loading batch">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-5 flex-1" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
      </Card>
      </>
    );
  }

  const doneCount = jobs.filter((j) => j.status === "done").length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;
  const finished = doneCount + failedCount;
  const pct = jobs.length > 0 ? Math.round((finished / jobs.length) * 100) : 0;

  return (
    <div>
      {/* The heading names the work, not the row that recorded it. Every bulk
          action in the product lands here, so by the peak-end rule this
          screen sets the memory of the whole interaction -- and it used to
          read "Batch" over a raw UUID. describeBatch() already had the
          sentence; it was rendered as a 12px grey caption underneath the
          schema's word for the table. */}
      <h1 className="mb-4 text-heading-sm font-semibold text-ink">{describeBatch(jobs)}</h1>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-body text-ink" aria-live="polite">
            {done
              ? `Finished — ${doneCount} succeeded, ${failedCount} failed.`
              : `In progress — ${finished} of ${jobs.length} finished.`}
          </p>
          {/* Determinate progress: the count is known, so a bar beats a spinner. */}
          <div
            className="mt-2 h-1 w-56 max-w-full overflow-hidden rounded-2xl bg-canvas"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Batch progress"
          >
            <div
              className="h-full rounded-2xl bg-ink transition-[width] duration-500 ease-[var(--ease-out-quint)]"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        {!done && (
          <button onClick={processNow} disabled={pending} className={buttonClass("outline")}>
            {pending && <IconSpinner size={16} />}
            {pending ? "Processing…" : "Process queue now"}
          </button>
        )}
      </div>

      {error && (
        <p className="mb-2 text-caption tracking-normal text-mid-gray">
          Refresh issue: {error} — retrying.
        </p>
      )}

      <Card className="overflow-hidden">
        <div className="scroll-x-hint">
          <table className="w-full min-w-[720px] text-body">
            <thead>
              <tr className={tableHeadClass}>
                <th scope="col" className="px-5 py-3 font-medium">Item</th>
                <th scope="col" className="px-5 py-3 font-medium">Site</th>
                <th scope="col" className="px-5 py-3 font-medium">Status</th>
                <th scope="col" className="px-5 py-3 font-medium">Attempts</th>
                <th scope="col" className="px-5 py-3 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className={tableRowClass}>
                  <td className={`${tableCellClass} font-medium text-ink`}>{j.label}</td>
                  <td className={`${tableCellClass} text-mid-gray`}>{j.site_name}</td>
                  <td className={tableCellClass}>
                    <StatusBadge tone={STATUS_TONE[j.status] ?? "idle"}>
                      {j.status.replace("_", " ")}
                    </StatusBadge>
                  </td>
                  <td className={`${tableCellClass} text-mid-gray`}>{j.attempts}</td>
                  {/* Wraps rather than truncating. The reason a job failed
                      was previously readable only by hovering for a `title`
                      tooltip -- not focusable, not announced, and unreachable
                      on a phone, which is where this page is most likely to
                      be read. Job #4 in PRODUCT.md is chasing a failure; this
                      column is the answer to it. */}
                  <td className={`${tableCellClass} max-w-md text-ember`}>
                    <span className="block break-words">{j.last_error ?? ""}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
