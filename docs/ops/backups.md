# Pre-update backups (UpdraftPlus)

Every plugin, theme and core update — queued or inline, from the panel or
over MCP — is preceded by a backup taken by the site's own **UpdraftPlus**
(the rule: back up before core AND plugin updates). The panel never takes a backup
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

## Inline updates (core, single plugin or theme, Plugins tab "Update all")

These run immediately and cannot wait for a backup:

- **Update core** on a site's overview;
- a single row's **Update** on the Plugins and Themes tabs;
- the Plugins tab's **Update all (N)** button (all plugins in one pass);
- the MCP tools `update_core`, `update_plugins` (one plugin or all) and
  `update_themes`.

Each only goes ahead when there is already a successful backup from the
last 6 hours; otherwise it is refused with the reason. Use **Back up now**,
wait for it to finish, refresh the inventory, and update. The MCP tools
check on the dry run (no confirm code is handed out when it would be
refused) and again when confirmed.

## Skipping the backup

Every dialog that queues updates has an unticked **Update without a
backup** checkbox; every inline update dialog has a separate
**… without a backup** button (**Update core without a backup**,
**Update without a backup**, **Update all without a backup**). Choosing
either sets `backup: "skip"` on the jobs (or skips the check for the
inline update) — nothing else changes. Over MCP the
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

## Setting up UpdraftPlus across the fleet

Dashboard → **Set up backups** queues a `backup_setup` job per site in the
environment shown (src/services/backup/setup.ts). On each site it:

1. installs and activates UpdraftPlus from wordpress.org if missing (or
   activates it if installed but inactive);
2. adds Google Drive as a destination, keeping any existing ones;
3. sets weekly file and database backups only where none are scheduled;
4. re-registers the WP-Cron schedule. graceland.ph was found (2026-09-30)
   with a weekly schedule configured but no cron event, so no backup had
   run since 18 July; this step is what fixes that state.

It is safe to re-run. The result of each site is in the activity log
(`site.backup_setup`, including `driveAuthorized`).

**The one manual step:** Google Drive must be authorized once per site, as
teamocsph@gmail.com: wp-admin → Settings → UpdraftPlus Backups → Settings →
Google Drive → *Sign in with Google*, then Save. Google's consent screen
cannot be completed by the panel. Until it is done, backups still run but
stay on the site's own server.
