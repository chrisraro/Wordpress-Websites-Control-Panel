import { getOptionalEnv } from "@/lib/env";
import type { GeoGridProvider } from "../types";

/**
 * Hands the grid to the team's n8n workflow and returns immediately; n8n posts
 * ranks back to the callback route, which completes the job.
 */
export function createN8nProvider(fetchImpl: typeof fetch = fetch): GeoGridProvider {
  return {
    name: "n8n",
    async run(req) {
      const url = getOptionalEnv("N8N_GEOGRID_WEBHOOK_URL");
      if (!url) {
        throw new Error("N8N_GEOGRID_WEBHOOK_URL is not configured — set it or use the stub provider");
      }
      const secret = getOptionalEnv("N8N_WEBHOOK_SECRET");
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-n8n-secret": secret } : {}),
        },
        body: JSON.stringify({
          run_id: req.runId,
          keyword: req.keyword,
          business: { name: req.businessName, place_ref: req.placeRef },
          points: req.points,
          callback_url: req.callbackUrl,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(`n8n webhook rejected the run: HTTP ${res.status}`);
      }
      return { kind: "awaiting" };
    },
  };
}
