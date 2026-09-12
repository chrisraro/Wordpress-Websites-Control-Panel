import { randomUUID } from "node:crypto";
import type { JobsRepo } from "@/services/jobs/repo";
import type { GeoGridConfig } from "./types";

/**
 * Queues one `geogrid_run` job per tracked keyword, all sharing one batch
 * id -- the handler (src/services/jobs/handlers.ts) requires each job's
 * payload to carry both `config_id` and `keyword`, so a GeoGrid run cannot
 * be a single job the way the other scan types are.
 *
 * Mirrors the insert loop in
 * src/app/(dashboard)/sites/[id]/geogrid-actions.ts#runGeoGridAction exactly,
 * so the MCP `run_geogrid` tool and the dashboard's "Run now" button queue
 * identical jobs. That action still has its own copy of this loop rather
 * than calling this function -- left for a follow-up so this task doesn't
 * touch unrelated UI code.
 *
 * `queued` may be 0 for a config with no keywords -- callers that consider
 * this an error (the MCP tool does) check `config.keywords.length` before
 * calling, so this function itself stays a pure "do the insert" helper with
 * no site-specific refusal logic of its own.
 */
export async function enqueueGeoGridRun(
  jobs: JobsRepo, siteId: string, config: GeoGridConfig,
): Promise<{ batchId: string; queued: number }> {
  const batchId = randomUUID();
  for (const keyword of config.keywords) {
    await jobs.insert({
      type: "geogrid_run",
      site_id: siteId,
      batch_id: batchId,
      payload: { config_id: config.id, keyword },
    });
  }
  return { batchId, queued: config.keywords.length };
}
