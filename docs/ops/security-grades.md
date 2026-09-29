# Security grades: coverage and "incomplete"

A security scan grades a site A–F from a 100-point score
(`computeGrade`, `src/services/security/types.ts`). Each check the scan
*could not run* is recorded as a 2-point `warn`, so before 2026-09-29 a scan
that verified almost nothing could still read A or B.

## What counts as coverage

`scanCoverage()` derives three flags from the scan's own checks, so the grade
and the checklist can never disagree:

| Flag | False when |
|---|---|
| `vuln_feed` | the vulnerability feed was never populated (`wordfence_feed`) or is older than 36h (`wordfence_feed_stale`) |
| `core_checksums` | the checksum PHP errored, or wordpress.org publishes no checksums for that version/locale (`core_checksums` warn carrying `details.error`) |
| `http_probes` | any of the outside probes (`xmlrpc_enabled`, `uploads_listing`, `security_headers`) got no HTTP answer |

A `core_checksums` warn for genuinely *missing* core files is a real result
and does not count as a gap.

## What happens when coverage is incomplete

- The score is capped at 79, so the grade is **at most C**. A grade already
  below C is left alone.
- The grade row (`security_checks`, `check_id = 'grade'`) stores
  `details.coverage` (the three flags) and `details.incomplete` (the list of
  gaps). No migration: it is the existing jsonb column.
- The security tab shows an **Incomplete** badge and names what could not be
  checked; the dashboard badge reads "Security C · incomplete"; the PDF and
  the `/r/<token>` page carry the same sentence (`incompleteGradeNotice`).
- Reports copy the gap list onto `reports.security_incomplete` (migration
  0024) at generation time, because the share page describes the PDF, not
  the site's current grade.

Grade rows written before this change have no `incomplete` field and are
shown unmarked — they are neither claimed complete nor incomplete. The next
nightly scan replaces them.

## Fixing a partial grade

| Gap | Remedy |
|---|---|
| `vuln_feed` | set `WORDFENCE_API_KEY` and let the nightly `vuln_feed_refresh` run (dashboard → System health shows the feed's state) |
| `core_checksums` | usually a WordPress version/locale wordpress.org has no manifest for; update core, or accept the gap |
| `http_probes` | the site blocks or times out requests from the panel (e.g. Cloudflare bot protection — see `cloudflare.md`) |
