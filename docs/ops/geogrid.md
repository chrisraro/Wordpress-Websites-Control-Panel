# GeoGrid setup

GeoGrid measures where a business ranks in Google's local pack across a grid of
coordinates. The panel owns the grid and the storage; a **provider** supplies the
rank at each point.

## Providers

- **stub** — deterministic sample ranks, no API cost, no configuration. Use it to
  see the map and validate the workflow end to end.
- **n8n** — the panel POSTs the grid to your n8n workflow, which looks up real
  ranks and posts them back.

Pick the provider per site in the GeoGrid tab's configuration form.

## Wiring the n8n provider

1. Import `docs/ops/n8n-geogrid-workflow.json` into n8n (Workflows → Import from file).
2. Replace the **Rank lookup (replace me)** node with a real lookup (DataForSEO
   `serp/google/maps/live/advanced`, SerpApi, etc.). It receives one item per grid
   point with `idx`, `lat`, `lng`, and must output `{ idx, rank }` where `rank` is
   1-20 or `null` when the business is not in the local pack.
3. Set an n8n environment variable `WP_PANEL_SECRET` to the same value you use for
   `N8N_WEBHOOK_SECRET` below.
4. Activate the workflow and copy its production webhook URL.
5. Set these in the panel's environment (`.env.local` locally, project settings on
   Vercel):

```
APP_URL=https://your-panel-domain
N8N_GEOGRID_WEBHOOK_URL=https://your-n8n/webhook/wp-panel-geogrid
N8N_WEBHOOK_SECRET=<a long random string>
```

## The contract

The panel sends:

```json
{
  "run_id": "<job uuid>",
  "keyword": "coffee shop",
  "business": { "name": "Test Cafe", "place_ref": null },
  "points": [{ "idx": 0, "lat": 14.61, "lng": 120.97 }],
  "callback_url": "https://your-panel-domain/api/webhooks/n8n/geogrid"
}
```

Your workflow replies (any time within 30 minutes):

```json
{ "run_id": "<same uuid>", "ranks": [{ "idx": 0, "rank": 4 }] }
```

Or reports a failure, which fails the job with your message:

```json
{ "run_id": "<same uuid>", "error": "SERP provider quota exceeded" }
```

Authentication: send either `x-n8n-secret: <N8N_WEBHOOK_SECRET>` (simplest) or
`x-n8n-signature: <hex HMAC-SHA256 of the raw body using the secret>`.

Only `idx` and `rank` are read from the callback — coordinates always come from the
panel's stored configuration, so a bad payload cannot move the grid. Runs that never
call back are failed automatically after 30 minutes and retried per the normal job
backoff.

## Constraints that are easy to miss

These are the details a near-miss integration gets wrong. A near-miss does not
error — it produces a uniformly unranked grid that reads as a real business
result — so check them explicitly when adapting an existing workflow.

- **Ack immediately.** The panel aborts its POST to your webhook after 30
  seconds and fails the job. Reply on receipt (`responseMode: onReceived`) and
  do the SERP lookups afterwards; do not hold the request open.
- **A non-2xx ack fails the run outright**, before any lookup happens.
- **Post back to the `callback_url` in the request body**, never a hardcoded
  URL. It changes with the deployment.
- **Field names are exact**: `{ run_id, ranks: [{ idx, rank }] }`. An entry
  whose `idx` is not a number is skipped. A `rank` that is not a number in
  1–20 becomes `null` silently — that includes `"3"` as a string.
- **`run_id` must be echoed unchanged.** A wrong or stale id gets
  `404 no run awaiting this id`, which is the clearest signal you have that the
  callback shape is wrong — check for it when testing.
- **Deadline is 30 minutes**; runs that never call back fail and retry on the
  normal job backoff.
