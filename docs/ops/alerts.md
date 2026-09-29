# Alerts (email via n8n)

The panel emails the team when something needs attention, **once per
incident**. It does not send email itself: at the end of every uptime run
(`/api/cron/uptime`, every 5 minutes — see `scheduling.md`) it works out which
alerts are new and POSTs them, in one request, to an n8n workflow that sends
the email.

Code: `src/services/alerts/` — `evaluate.ts` (pure rules), `repo.ts` (DB reads
and the dedupe ledger), `send.ts` (the n8n request), `service.ts` (the run).

## Configuration

| Env var | Meaning |
|---|---|
| `N8N_ALERT_WEBHOOK_URL` | The n8n alert workflow's webhook URL. |
| `N8N_ALERT_SECRET` | Sent as the `x-ocs-shared-secret` header; n8n rejects requests without it. Generate with `openssl rand -hex 32`. |
| `APP_URL` | Optional here. When set, every alert line links to the site in the panel. |

If either `N8N_ALERT_WEBHOOK_URL` or `N8N_ALERT_SECRET` is unset, alerting is
**off**: each uptime run logs one info line
(`alerts: N8N_ALERT_WEBHOOK_URL / N8N_ALERT_SECRET not set; alerting is off`),
reads nothing and sends nothing. Nothing is recorded as sent while alerting is
off, so when it is switched on the first run reports whatever is still inside
the windows below (e.g. critical vulnerabilities from the last 7 days).

## The request

```
POST $N8N_ALERT_WEBHOOK_URL
x-ocs-shared-secret: $N8N_ALERT_SECRET
content-type: application/json

{
  "subject": "[WP Panel] 2 sites down, 1 critical vulnerability",
  "text": "Sites down\n- Alpha is down: ...\n\nCritical vulnerabilities\n- ...",
  "alerts": [
    { "kind": "site_down", "site": "Alpha", "message": "Alpha is down: the last two uptime checks failed (HTTP 503). https://panel.example/sites/<id>" }
  ],
  "dry_run": false
}
```

`kind` is one of `site_down`, `site_recovered`, `ssl_expiring`,
`critical_vulnerability`, `jobs_failed`. `site` is the site name, or `null`
for fleet-wide alerts (e.g. a failed `vuln_feed_refresh`). The request times
out after 15 seconds and does not follow redirects. At most one request is
made per run, and none when there is nothing new.

Nothing secret leaves the panel: no credentials, ids or dedupe keys; job
error text is flattened to one line and cut at 200 characters.

## What triggers each alert

All rules read the database with the service-role client. Disabled sites are
ignored.

| Kind | Fires when | Repeats |
|---|---|---|
| `site_down` | The site's latest **two** uptime checks both failed (about 10 minutes — a single blip does not alert) and there is no open incident. | Once per incident. |
| `site_recovered` | The latest check is ok and the last up/down alert for the site was `site_down`. Closes the incident. | Once per incident. |
| `ssl_expiring` | The latest check reports fewer than 14 days of certificate validity (negative = already expired). | At most once per 24h per site. |
| `critical_vulnerability` | An `open` row in `site_vulnerabilities` with severity `critical` (case-insensitive) **or** a feed CVSS ≥ 9, first seen within the last 7 days. | Once per vulnerability row. |
| `jobs_failed` | Jobs with status `failed`, finished in the last 24h, not dismissed. All of a site's new failures are bundled into one line (types, count, latest error). | Once per job. |

## Dedupe

After n8n accepts the request, the panel writes one `activity_log` row per
alert key:

```
action   = 'alert.sent'
actor    = '00000000-0000-0000-0000-000000000000'   -- the scheduler, not a person
site_id  = the site (null for fleet-wide)
detail   = { "kind": "<kind>", "key": "<key>" }
```

Keys: the check's `checked_at` for `site_down`/`site_recovered`, the days
remaining for `ssl_expiring`, `site_vulnerabilities.id` for
`critical_vulnerability`, and the job id for `jobs_failed` (one row per job in
a bundle).

- Up/down state is the newest `site_down`/`site_recovered` row for the site,
  however old: an incident stays open until the site's next ok check sends
  `site_recovered`, even if that takes weeks.
- If the send fails (timeout, non-2xx), nothing is recorded and the next run
  retries the same alerts. The uptime route still answers 200 and reports
  `"alerts": { "sent": 0, "error": "..." }`.
- If the send succeeds but writing the rows fails, the route reports
  `"alerts": { "sent": N, "error": "alerts sent but failed to record; ..." }`
  and the next run may send those alerts once more.

These rows also appear in the site's activity feed on its overview page.
`prune_history()` keeps the activity log forever, so the ledger is never
trimmed.

## Testing

**The n8n side, without email going out** — post a `dry_run: true` payload
straight to the workflow (it must skip the send step when `dry_run` is true):

```bash
curl -sS -X POST "$N8N_ALERT_WEBHOOK_URL" \
  -H "content-type: application/json" \
  -H "x-ocs-shared-secret: $N8N_ALERT_SECRET" \
  -d '{"subject":"[WP Panel] 1 site down","text":"Sites down\n- Test is down.","alerts":[{"kind":"site_down","site":"Test","message":"Test is down."}],"dry_run":true}'
```

A request without the header, or with a wrong secret, should be rejected.

**The panel side** — trigger an uptime run by hand and read the `alerts`
field:

```bash
curl -sS -H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/cron/uptime"
# {"ok":true,"sites":12,"down":0,"alerts":{"sent":0,"error":null}}
```

The panel always sends `dry_run: false`; to rehearse a real alert, point
`N8N_ALERT_WEBHOOK_URL` at a test workflow (or a request bin) in a preview
environment. Inspect what has been sent with:

```sql
select at, site_id, detail from activity_log
where action = 'alert.sent' order by at desc limit 50;
```

Unit tests: `tests/alerts-*.test.ts` and `tests/cron-uptime-route.test.ts`.
