# Pre-update backups (UpdraftPlus)

Queued plugin and theme updates, and the core update, are preceded by a
backup taken by the site's own **UpdraftPlus**. (Single-row updates and the
Plugins tab's inline "Update all" are not gated yet.) The panel never takes a backup
itself: shared hosting and serverless time limits rule that out. It asks
UpdraftPlus to run one (scheduled on WP-Cron, so it runs in the site's PHP)
and checks back until UpdraftPlus records a finished run.

Code: `src/services/backup/updraft.ts` (status read, request, decision),
`src/services/backup/gate.ts` (what jobs and buttons call).

## Requirement

UpdraftPlus must be installed and active on the site. Remote storage is
UpdraftPlus's own setting; the panel only starts the backup and reads
`updraft_last_backup`. A site without UpdraftPlus **fails** its updates
rather than updating unbacked, unless the operator explicitly chooses
"Update without a backup".

## Queued updates (bulk and fleet)

Applies to bulk **Update** on a site's Plugins and Themes tabs, the
dashboard's **Update plugins on N sites**, and the MCP tool
`update_all_plugins_fleet`. Before each job touches the site:

| Site state | What happens |
|---|---|
| Successful backup in the last **6 hours** | Update runs. |
| No fresh backup | Panel requests one; the job is deferred and checks again every **2 minutes** (deferral does not use up a retry). |
| Requested backup finished successfully | Update runs. |
| Requested backup finished with errors | Job fails, no retry: "The pre-update backup finished with errors…". |
| Backup not finished within **60 minutes** | Job fails, no retry. |
| No UpdraftPlus | Job fails, no retry: "No supported backup plugin is active…". |
| Site unreachable | Normal retry ladder. |

Operators see this on the batch page: jobs waiting for the backup simply
stay pending (re-checked every 2 minutes), and a failed job shows one of
the reasons above. Nothing was updated on a job that
failed at the backup step, so re-running it (after fixing UpdraftPlus, or
choosing to skip the backup) is safe.

## Inline core update

**Update core** on a site's overview runs immediately and cannot wait, so
it only goes ahead when there is already a successful backup from the last
6 hours; otherwise it is refused with the reason. Use **Back up now**, wait
for it to finish, refresh the inventory, and update. The MCP `update_core`
tool behaves the same way (checked on the dry run and again when
confirmed).

## Skipping the backup

Every dialog that queues updates has an unticked **Update without a
backup** checkbox; the core update dialog has a separate **Update core
without a backup** button. Choosing either sets `backup: "skip"` on the
jobs (or skips the check for core) — nothing else changes. Over MCP the
same choice is `skip_backup: true`, which is part of the confirm code, so
a dry run without it cannot be confirmed with it. Bulk skips are recorded
in the activity log entry's `detail.backup`; MCP calls record their
arguments in the audit row.

Only skip when a recent backup exists some other way (host snapshots, a
manual UpdraftPlus run you have checked).

## Site page

The Connection card shows **Last backup** from the latest inventory
snapshot: a relative time "(UpdraftPlus)", "No backup plugin", "Last
backup failed" or "None yet". It is as fresh as the last inventory
refresh. **Back up now** (staff with `wp_toolkit.manage` and a manage
grant, shown where UpdraftPlus was found) starts a backup and logs
`site.backup.request`; refresh the inventory later to see the result.
