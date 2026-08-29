"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";

interface RunSummary {
  id: string;
  status: "pending" | "running" | "awaiting_callback" | "done" | "failed";
  keyword: string;
  last_error: string | null;
}

/**
 * n8n's per-point lookups take minutes, not seconds — nothing like the
 * batch queue's poller (poller.tsx), which watches a queue that can drain in
 * well under a second and polls every 4s accordingly. Polling this fast for
 * a GeoGrid run would just be dozens of wasted requests while n8n is still
 * mid-workflow. 20s keeps the tab visibly live without hammering the API for
 * a job whose fastest realistic completion is well over a minute.
 */
const POLL_MS = 20_000;

/**
 * Silent watcher, not a UI: the GeoGrid page (page.tsx) already renders the
 * map, stats and history from the server on every request (it's
 * `force-dynamic`), so this component's only job is to notice when an
 * in-flight run settles and then (a) tell the user what happened and (b)
 * pull the finished run's data in via router.refresh() — the JSON this
 * polls is deliberately too thin to redraw the map itself.
 *
 * `active` is server-computed (see page.tsx's `openRuns`) and gates polling
 * entirely: while nothing is open, this component's effect returns
 * immediately on mount and issues no request at all, matching the "an idle
 * GeoGrid tab must issue no requests" requirement. When active flips back to
 * true — e.g. router.refresh() below reveals a newly queued run — the
 * effect's dependency change restarts polling from a clean slate.
 */
export function GeoGridRunPoller({ siteId, active }: { siteId: string; active: boolean }) {
  const [result, setResult] = useState<{ jobs: RunSummary[]; done: boolean } | null>(null);
  const router = useRouter();
  const { toast } = useToast();
  const announced = useRef(false);

  useEffect(() => {
    if (!active) return;
    announced.current = false;
    setResult(null);
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch(`/api/sites/${siteId}/geogrid-runs`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { jobs: RunSummary[]; done: boolean };
        if (stop) return;
        setResult(data);
        // Stop condition: once settled there is nothing left to watch for
        // this mount. A fresh run queued later arrives via `active` flipping
        // false-then-true on a subsequent server render, not by this loop
        // continuing to poll an idle tab.
        if (!data.done) timer = setTimeout(poll, POLL_MS);
      } catch {
        if (stop) return;
        timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [siteId, active]);

  // Announce once per settle — the user may have looked away for minutes —
  // and pull the finished run into view. router.refresh() re-runs the
  // Server Component, which recomputes `active`; if it comes back false the
  // effect above simply stays idle on its next run.
  useEffect(() => {
    if (!result?.done || announced.current) return;
    announced.current = true;
    if (result.jobs.length > 0) {
      const failed = result.jobs.filter((j) => j.status === "failed");
      const ok = result.jobs.filter((j) => j.status === "done");
      toast(
        failed.length > 0
          ? {
              tone: "error",
              title: "GeoGrid scan finished with failures",
              description: failed[0].last_error
                ? `${failed[0].keyword}: ${failed[0].last_error}`
                : `${failed.length} of ${result.jobs.length} keyword(s) failed.`,
            }
          : {
              tone: "success",
              title: "GeoGrid scan complete",
              description: `${ok.length} keyword${ok.length === 1 ? "" : "s"} updated.`,
            },
      );
    }
    router.refresh();
  }, [result, router, toast]);

  return null;
}
