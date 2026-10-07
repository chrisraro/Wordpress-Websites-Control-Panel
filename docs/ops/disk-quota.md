# Runbook: a site is over its cPanel disk quota

Applies to: nagacityguide.com, onlinecreativesolutions.com (reported over
quota 2026-10-07 even after deleting backups in UpdraftPlus).

## Why deleting UpdraftPlus backups often does not bring the quota down

1. **cPanel's figure is cached.** The quota shown updates on a schedule
   (often every few hours). cPanel → *Disk Usage* recalculates on open.
2. **cPanel File Manager's Trash counts.** Files deleted in File Manager go
   to `~/.trash` and still count until *Empty Trash*.
3. **Leftover backup pieces.** UpdraftPlus's *Delete* removes only sets in its
   history. Parts of failed or interrupted runs (`backup_*.zip` not in the
   history, `*.tmp`) stay in `wp-content/updraft`. UpdraftPlus →
   *Existing backups* → *Rescan local folder* shows them.
4. **The backup itself needs room.** UpdraftPlus builds every archive on the
   server before uploading it. Naga City Guide's full backup is ~7.6 GB
   (Sep 2026), so each scheduled run needs ~7.6 GB free on the account while
   it runs, even with "delete local copies after upload" on. On a small plan
   that alone pushes the account over quota every two weeks.
5. **Everything else on the account**: email (`~/mail`), other domains,
   `~/logs`, `~/tmp`, `error_log` files, other plugins' backups
   (Duplicator, All-In-One Security), caches.

## Step 1: measure (read-only)

Run through the site's Novamira MCP (`novamira/execute-php`). Tested on
graceland.ph 2026-10-07 (~1 s). Reports the size of every top-level folder
in the hosting account, every file over 50 MB, and UpdraftPlus archives not
in its backup history ("orphans").

```php
$deadline = microtime(true) + 25; $home = dirname(rtrim(ABSPATH, '/'));
$mb = function ($b) { return round($b / 1048576, 1); };
$top = array(); $big = array(); $partial = false;
foreach (scandir($home) as $e) {
  if ($e === '.' || $e === '..') continue; $p = $home . '/' . $e;
  if (is_link($p)) continue; if (is_file($p)) { $top[$e] = filesize($p); continue; }
  $t = 0;
  try {
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($p, FilesystemIterator::SKIP_DOTS),
      RecursiveIteratorIterator::LEAVES_ONLY, RecursiveIteratorIterator::CATCH_GET_CHILD);
    foreach ($it as $f) {
      if (microtime(true) > $deadline) { $partial = true; break 2; }
      if ($f->isFile() && !$f->isLink()) { $s = $f->getSize(); $t += $s; if ($s > 50 * 1048576) $big[$f->getPathname()] = $s; }
    }
  } catch (Exception $ex) {}
  $top[$e] = $t;
}
arsort($top); arsort($big);
$hist = get_option('updraft_backup_history'); $known = array();
if (is_array($hist)) foreach ($hist as $h) foreach ((array) $h as $k => $v) {
  if (is_array($v)) { foreach ($v as $fn) if (is_string($fn)) $known[$fn] = 1; }
  elseif (is_string($v) && preg_match('/\.(zip|gz)$/', $v)) $known[$v] = 1;
}
$udir = WP_CONTENT_DIR . '/' . (get_option('updraft_dir') ?: 'updraft'); $orphans = array();
foreach ((array) glob($udir . '/backup_*') as $f) if (!isset($known[basename($f)])) $orphans[basename($f)] = $mb(filesize($f));
return array('partial' => $partial, 'home_top_mb' => array_map($mb, array_slice($top, 0, 15, true)),
  'largest_files_mb' => array_map($mb, array_slice($big, 0, 15, true)), 'updraft_orphans_mb' => $orphans);
```

## Step 2: clean up (only what step 1 found, after showing it)

- UpdraftPlus orphans and `*.tmp` in `wp-content/updraft`: safe to remove
  once listed (they are not restorable sets).
- `~/.trash`: empty it (cPanel File Manager → *Empty Trash*).
- Old Duplicator / AIOS / other backup archives: remove after confirming
  they are not the only copy of something.
- Turn on UpdraftPlus *Settings → Expert settings → Delete local backup
  files after upload*, so nothing stays on the server after a run.

## Step 3: stop it recurring (large sites)

For a site whose full backup is a large share of the plan, either raise the
plan's quota, or split the schedule: database every two weeks, files
monthly, with `wp-content/uploads` backed up incrementally or excluded from
scheduled runs if the media is kept elsewhere. Decide per site; record it
here.
