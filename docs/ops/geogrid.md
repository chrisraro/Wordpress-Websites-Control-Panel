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
   point with `idx`, `lat`, `lng`, and must output `{ idx, rank, measured }` where
   `rank` is 1-20 or `null` when the business is not in the local pack, and
   `measured` is `true` when that point's lookup completed (ranked or not) and
   `false` when it failed. Catch a per-point failure inside this node and emit
   `measured: false` for that point — do not let it throw, which would fail
   every other point in the run too.
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

Your workflow replies (any time within 30 minutes), echoing `run_id` back
exactly as received — including its `:<attempt>` suffix if the panel sent
one (see "The panel sends" above; treat the whole string as opaque):

```json
{ "run_id": "<run_id exactly as received, e.g. \"abc123:0\">", "ranks": [{ "idx": 0, "rank": 4, "measured": true }] }
```

`measured` is optional: **omitting the field entirely** defaults to `true`,
for compatibility with a workflow that hasn't been updated yet — every entry
an old workflow posts is a real lookup. Any value that *is* present but is
not the **literal boolean** `true` is read as **not measured** — this
correctly catches `false`, but it also catches a stringified `"true"` or
`"false"`, `1`, or anything else your workflow's Set/Code nodes might coerce
the field to. That fails closed (an ambiguous value is never promoted to "did
rank"), but it means a workflow that stringifies booleans and sends
`measured: "true"` will have every one of its real measurements silently
recorded as unmeasured, with no error anywhere — make sure your workflow
emits an actual boolean. Send `measured: false` (with `rank` omitted or
ignored) for a point whose lookup failed; a point missing from `ranks[]`
entirely is treated the same way.

Or reports a total failure — nothing could be measured at all — which retries
the job on the normal backoff and fails it only once that's exhausted:

```json
{ "run_id": "<run_id exactly as received>", "error": "SERP provider quota exceeded" }
```

Never send `error` alongside a non-empty `ranks[]`: a body carrying both is
read as the partial result it is (the `ranks[]` win), so a workflow that
means "1 of 81 points failed" must report those 80 good points via `ranks[]`
with `measured: false` on the failed one, not via `error`.

Authentication: send either `x-n8n-secret: <N8N_WEBHOOK_SECRET>` (simplest) or
`x-n8n-signature: <hex HMAC-SHA256 of the raw body using the secret>`.

Only `idx`, `rank`, and `measured` are read from the callback — coordinates
always come from the panel's stored configuration, so a bad payload cannot
move the grid. `run_id` is echoed back exactly as sent, including its
`:<attempt>` suffix if the panel included one — treat it as an opaque string,
never parse or regenerate it. Runs that never call back are failed
automatically after 30 minutes and retried per the normal job backoff.

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
- **Field names are exact**: `{ run_id, ranks: [{ idx, rank, measured }] }`.
  An entry whose `idx` is not a number is skipped, as is a second entry for an
  `idx` already seen (the first wins). A `rank` that is not a number in 1–20
  becomes `null` silently — that includes `"3"` as a string. `measured` must
  be the literal boolean `true` to count as measured; anything else present —
  including the string `"false"`, or a stringified `"true"` — is treated as
  **not measured** (fails closed). Only *omitting* the field entirely
  defaults to measured, for backward compatibility with workflows that
  predate this field.
- **`run_id` must be echoed unchanged**, including its `:<attempt>` suffix if
  the panel sent one — never parse or regenerate it. A wrong or expired id
  gets `404 no run awaiting this id`; a `run_id` for an attempt the job has
  since moved on from (e.g. a late callback from a since-retried execution)
  gets `404 stale attempt` instead. Either is the clearest signal you have
  that the callback shape or timing is wrong — check for both when testing.
- **Deadline is 30 minutes**; runs that never call back fail and retry on the
  normal job backoff.
