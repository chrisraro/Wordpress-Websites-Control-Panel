"use client";

import { useEffect, useState, useTransition } from "react";
import { processQueueNowAction } from "../../actions";

interface BatchJob {
  id: string; site_id: string | null; site_name: string;
  status: string; attempts: number; last_error: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-slate-200 text-slate-600",
  running: "bg-blue-100 text-blue-800",
  awaiting_callback: "bg-blue-100 text-blue-800",
  done: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export function BatchPoller({ batchId }: { batchId: string }) {
  const [jobs, setJobs] = useState<BatchJob[] | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [batchId]);

  const processNow = () => {
    startTransition(async () => { await processQueueNowAction(); });
  };

  if (!jobs) return <p className="text-sm text-slate-500">Loading batch…</p>;

  const doneCount = jobs.filter((j) => j.status === "done").length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600" aria-live="polite">
          {done
            ? `Finished: ${doneCount} succeeded, ${failedCount} failed.`
            : `In progress — ${doneCount + failedCount}/${jobs.length} finished. The queue runs every minute.`}
        </p>
        {!done && (
          <button onClick={processNow} disabled={pending}
            className="min-h-10 rounded border px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50">
            {pending ? "Processing…" : "Process queue now"}
          </button>
        )}
      </div>
      {error && <p className="mb-2 text-xs text-red-600">Refresh issue: {error} (retrying)</p>}
      <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3">Site</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Attempts</th>
              <th className="px-4 py-3">Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-b last:border-0">
                <td className="px-4 py-2 font-medium">{j.site_name}</td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[j.status] ?? STATUS_STYLE.pending}`}>
                    {j.status.replace("_", " ")}
                  </span>
                </td>
                <td className="px-4 py-2">{j.attempts}</td>
                <td className="max-w-64 truncate px-4 py-2 text-xs text-red-600" title={j.last_error ?? undefined}>
                  {j.last_error ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
