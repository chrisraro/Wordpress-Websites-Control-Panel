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

---

# Round 2 — open items and features (same day)

Every "Still open" item and every "Features worth adding" item above was
worked, test-first, in parallel streams (plan:
`docs/superpowers/plans/2026-09-29-audit-followups.md`), then merged and put
through a fresh cross-stream review whose HIGH finding is fixed.

**State:** 2,197 unit tests + 26 Playwright checks green, `tsc` clean,
`next build` green on **Next 16.3.6**, `npm audit` **0 vulnerabilities**.
Migrations 0022–0028 applied twice each against Postgres 16 (re-runnable);
0025 and 0028 behaviour exercised with real rows / real `authenticated`
sessions.

## Deploy checklist (round 2) — do these in order

1. Apply migrations **0024 → 0028** (0022/0023 from round 1 first if not
   yet applied). 0024 must be applied before the code deploys (reports
   queries select its columns). 0025 schedules itself on pg_cron.
2. Set env vars in Vercel:
   - `N8N_ALERT_WEBHOOK_URL=https://n8n-ocs.onrender.com/webhook/wp-panel-alerts`
   - `N8N_ALERT_SECRET` = the value in the n8n workflow **"OCS — WP Panel
     Alerts"** → node *Verify Shared Secret* (not stored in this repo).
3. Deploy. Existing report share links keep working with no expiry; new
   manual ones expire after 30 days; monthly reports get a link on request.
4. For pre-update backups, install and configure **UpdraftPlus** on each
   site (with remote storage). Sites without it will refuse updates unless
   the operator chooses "Update without a backup".

## Open items — resolved

| # | Item | Resolution |
|---|---|---|
| 1 | Next 16 | Upgraded to 16.3.6; last advisory cleared; CI audit gate raised to `high`. `middleware.ts` kept (deprecated name, still works). |
| 2 | Partial security grade | Coverage tracked per scan; grade capped at C and marked "incomplete" in UI, dashboard, PDF and share page. |
| 3 | Retries → "degraded" | Only the retry ladder's final attempt counts. |
| 4 | Connect-time SSRF | `net-guard` checks every hop, at connect time (DNS-rebinding), and on redirects (`redirect: "manual"`). |
| 5 | Destructive MCP confirm | Dry run issues a 10-minute HMAC `confirm_code` bound to user, tool, site and arguments; site strings stripped/capped in tool output. |
| 6 | Retention | Nightly `prune_history()` with the approved windows; newest row per site always kept. |
| 7 | Share links | 30-day expiry for manual reports; monthly reports unshared until asked; MCP link tool state-aware. |
| 8 | Enqueue-time authority | Handlers re-check the actor when the job runs; unreadable access retries, revoked access fails. |
| 9 | Matrix self-elevation | Admin-only in the app **and** RLS (0028), which also closes direct `user_roles`/overrides writes. |
| 10 | Test gaps / CI | Route-handler and rootfiles tests; GitHub Actions: tests, tsc, build, Playwright, audit. |

## Features — shipped

- **Email alerts** via n8n (site down/recovered, SSL < 14 days, new critical
  vulnerability, failed jobs), once per incident — `docs/ops/alerts.md`.
- **Pre-update backups** through UpdraftPlus for queued and inline updates,
  one backup shared per site, "Back up now" and last-backup status on the
  site page — `docs/ops/backups.md`.
- **Staging ↔ production pairing** with a drift card (0026).
- **Maintenance windows** per site; bulk updates can wait for them (0027).
- **Client home**: uptime %, SSL, last backup, maintenance this month, latest
  report — no staff vocabulary, grant-scoped.
- **Playwright E2E** smoke suite (desktop + phone) in CI.

## Still worth doing

- Rename `middleware.ts` → `proxy.ts` (Next 16 convention; needs your OK
  since it removes the old file).
- The MCP fleet tool cannot yet choose a maintenance window.
- Playwright covers anonymous/machine boundaries only; signed-in flows need
  a seeded Supabase test project.
- Trim ECC's rules in the cloud setup script (move unused language rule
  folders out of `~/.claude/rules/ecc` after install).

Routing (round 2): 0 haiku · 1 sonnet · 8 main · 0 escalated · Jev exec 5639
