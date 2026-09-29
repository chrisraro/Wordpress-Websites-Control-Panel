# Audit verdict — 2026-09-29

First run of the Jev + ECC workflow on this repo (see `CLAUDE.md`). Five
specialist reviews (security, database/RLS, TypeScript correctness, silent
failures, React/UI) plus dependency, coverage and codemap passes; fixes made
test-first; a final cross-stream review of the combined diff.

**Verdict: solid foundation, now safer to run unattended.** The codebase was
already disciplined — base64-only PHP embedding, fail-closed authz in three
layers, hashed API tokens, RLS on every table, 1,479 green tests. The real
risk was not in any single screen but in the **background machinery**: the
job queue could act on a live client site twice, loop forever on a killed
job, or report success for work that failed. That is fixed. The one outright
production bug was that **the panel's own MCP server was unreachable** for
token clients.

Baseline → now: 1,479 → 1,664 tests, `tsc` clean, production build green.

## Deploy checklist

1. Apply `supabase/migrations/0022_claim_jobs_hardening.sql` and
   `0023_fk_indexes_and_function_grants.sql` (SQL editor), **before or with**
   the deploy. The code works against the old `claim_jobs`, but the stuck-job
   cap and per-site serialisation only exist once 0022 is applied.
2. Deploy. Then `claude mcp add --transport http wp-control-panel …` should
   connect for the first time.
3. Sites must use `https://` and resolve to a public address to be *added*
   or have their origin override changed; existing records are untouched.
4. A user can no longer change their own role, and only an admin can assign
   `admin` (`docs/ops/authorization.md` updated).

## What was fixed

| Area | Problem | Impact before |
|---|---|---|
| MCP | Middleware 307'd bearer-token requests to `/login` | MCP server unusable in production |
| Jobs | Status write after a successful handler inside its `try` | A DB blip re-ran installs/deletes on live sites |
| Jobs | Transitions updated by id only | Late attempts / callback races resurrected finished jobs |
| Jobs | 3 jobs claimed up front, no deadline; stale reclaim uncapped | Killed jobs looped every 15 min forever (e.g. 155 MB feed) |
| Jobs | No per-site serialisation; dedupe ignored running + cancelled | Two upgrader passes on one site; cancelled jobs blocked re-queue |
| DB | 5 unindexed FKs; PUBLIC execute on RLS helpers | Full scans on dedupe and site deletes |
| Security | Forged `{kind:"url"}` install source accepted | Unaudited remote ZIP install |
| Security | Batch cancel/retry not scoped to site grants | Act on sites outside your grants |
| Security | Raw `last_error` returned to client-role viewers | Internal paths/errors leaked to customers |
| Security | Any URL/IP accepted for sites (http, private ranges) | SSRF + app password in cleartext |
| Security | `users.manage` could change own role to admin | Self-elevation |
| Silent | SEO scan with every source failing = "done" | No retry for a week; looked scanned |
| Silent | Expired TLS cert → "no SSL data" | The one case the check exists for was hidden |
| Silent | Vuln feed lookup truncated at 1,000 rows | Vulnerable sites graded too high |
| Silent | Audit write failure turned success into failure | Operators retried → duplicate fleet batches |
| Silent | No fetch timeouts on Google/discovery/GSC/Wordfence | Hung requests held queue slots |
| Silent | Nightly enqueue: one site's error aborted all; weekly SEO ran every 8 days | Missed nightly work; drifting cadence |
| UI | Connect-site modal stayed open after navigating | Modal over the new site page |
| UI | No `error.tsx` / `global-error.tsx` | Raw 500 page, no way back (bad on phone) |
| UI | Batch page froze after Retry/Cancel | No progress for requeued jobs |
| UI | Forms shown that the server refuses; token dates hydration mismatch | Dead-end forms; console errors |
| Deps | undici, fast-uri, qs, ip-address advisories | Patched within semver |

## Still open — recommended next (priority order)

1. **Upgrade to Next 16.** Clears the last `npm audit` item (bundled
   `postcss`, high). Breaking; do it as its own planned change.
2. **Security grade should say when it is partial.** A scan where the vuln
   feed was missing, checksums failed and probes were unreachable can still
   grade A/B (each "could not check" costs 2 points). Store a coverage flag
   on the grade and show "incomplete" in the UI and reports.
3. **Security scan retries count toward "degraded".** Three ladder attempts
   in ~6 minutes during one outage mark a site degraded; count only terminal
   failures.
4. **Connect-time SSRF check.** The new guard runs when a site is saved; DNS
   rebinding and redirects to private addresses during scans are not blocked.
   Enforce in `src/lib/mcp/*` and use `redirect: "manual"` on probes.
5. **Destructive MCP tools need a human-grade confirm.** `confirm` + `reason`
   come from the same model that reads site-controlled text (plugin names,
   error strings), so a hostile site could steer it. Return a one-time code in
   the dry run that must be echoed back, and truncate site strings in tool
   output.
6. **Data retention policy.** `uptime_checks` (~105k rows/site/year), `jobs`,
   snapshots and the activity log grow without bound. Decide retention
   windows, then add a pg_cron cleanup (a data-deletion decision, deliberately
   not automated in this pass).
7. **Share links should expire**, and monthly auto-reports should not mint a
   permanent live link per site per month.
8. **Queued jobs run with enqueue-time authority.** Re-check the actor's
   grant in the handler before acting on a live site.
9. **Matrix self-elevation.** A `users.manage` holder can still grant their
   own role any permission via the matrix; restrict matrix edits to admins.
10. **Test gaps:** cron/batch route handlers and `rootfiles/service.ts` have
    no direct tests; there is no linter and no CI.

## Features worth adding

- **CI on every push** (GitHub Actions: `npm ci`, `vitest run`, `tsc`,
  `next build`, `npm audit`). The suite is fast (~12 s); nothing runs it today.
- **Pre-update backups.** The core-update dialog tells operators to "take a
  backup first"; the panel could snapshot DB + `wp-content` via Novamira before
  core/plugin updates and keep the last N, making bulk updates reversible.
- **Alerting.** Push site-down, SSL < 14 days, new critical vulnerability and
  failed nightly jobs to email/Slack (the n8n instance already exists) instead
  of waiting for someone to open the dashboard.
- **Client portal polish.** Clients are a confirmed audience with no accounts
  yet; a client home that leads with "your site is healthy" evidence, report
  history and uptime is the product the PRODUCT.md framing asks for.
- **Staging ↔ production diff.** Four sites are staging copies; show plugin/
  version drift between a staging site and its production pair before a push.
- **Maintenance windows.** Let bulk updates be scheduled into a per-client
  window rather than run on click.
- **Playwright E2E** for the three flows that matter most: connect a site, bulk
  update, generate and share a report.

## Agent workflow notes

- **ECC profile is too broad.** The `developer` install loads path-scoped rules
  for HarmonyOS, Vue, React Native, Kotlin, etc.; opening one `.ts` file pulled
  ~10k tokens of irrelevant rules. Reinstall with only the modules this repo
  uses (TypeScript, React, web, common) via `install.sh --modules …` or
  `--without`.
- **Haiku output needs the main-model check.** The coverage map missed tests
  that import modules dynamically; the check caught it.

Routing: 2 haiku · 1 sonnet · 9 main · 0 escalated · Jev exec 5622, 5623
