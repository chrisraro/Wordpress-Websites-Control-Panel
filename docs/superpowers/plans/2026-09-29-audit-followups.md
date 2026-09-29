# Audit follow-ups and new features — plan

Source: `docs/audits/2026-09-29-audit-verdict.md` ("Still open" 1–10 and
"Features worth adding"). Every stream works test-first, keeps `npm test`,
`npx tsc --noEmit` and `npm run build` green, one Conventional Commit per
change. Streams own disjoint files and migration numbers so they can run in
parallel worktrees.

## Streams

| Stream | Items | Owns | Migration | Model |
|---|---|---|---|---|
| S1 Security hardening | open 4 (connect-time SSRF + manual redirects), 5 (confirm code for destructive MCP tools, truncate site strings), 8 (handler re-checks actor authority), 9 (matrix edits admin-only) | `src/lib/mcp/*`, `src/lib/net-guard.ts`, `src/mcp/**`, `src/services/jobs/handlers.ts`, `src/services/users/*`, `users/roles/*`, security probes | none | main (security) |
| S2 Scan + reports | open 2 (grade coverage / "incomplete"), 3 (degraded counts terminal failures only), 7 (share-link expiry, no auto link for monthly reports) | `src/services/security/scan.ts`, `types.ts`, `src/services/sites/repo.ts` (recordScanResult), `src/services/reports/**`, `src/app/r/**`, security + reports UI | `0024` | main (judgment) |
| S3 Tests + CI | open 10 (route-handler tests for cron/batches/geogrid-runs, `rootfiles/service.ts`), feature CI | `tests/**` new files only, `.github/workflows/ci.yml` | none | per Jev |
| S4 Retention | open 6 | prune function + ops doc | `0025` | main (data deletion — windows need owner sign-off; ships unscheduled) |
| S5 Alerting | feature | `src/services/alerts/*`, cron hooks, env | none | main |
| S6 Staging ↔ production | feature: pair a staging site with its production site, show drift | sites repo/UI | `0026` | main |
| S7 Maintenance windows | feature: schedule bulk updates into a per-site window | jobs enqueue path, site settings | `0027` | main |
| S8 Client home | feature: client-facing health summary | client dashboard UI | none | main (client-facing) |
| S9 Pre-update backup | feature: decision needed (see below) | manage service | — | main |
| S10 Next 16 | open 1 | `package.json`, framework breakages | none | main, last, alone |
| S11 Playwright E2E | feature | `e2e/**`, config | none | after S10 |

Order: S1, S2, S3 in parallel → S4/S5 → S6/S7/S8 → S9 → S10 → S11 → final
cross-stream review → verdict update.

## Decisions needed from the owner

- Retention windows (S4) — deleting history is irreversible.
- Alert channel (S5) — n8n webhook → email / Slack / both.
- Backup approach (S9) — which mechanism is acceptable on this hosting.
