<?php
// Minimal WordPress surface for running the panel's site PHP in tests.
// The scenario arrives as JSON on argv[1]; the PHP under test on argv[2].
$S = json_decode(file_get_contents($argv[1]), true);
define('ABSPATH', '/tmp/');
define('HOUR_IN_SECONDS', 3600);
define('DAY_IN_SECONDS', 86400);
$GLOBALS['__opts'] = $S['options'];
$GLOBALS['__cron'] = array();
$GLOBALS['__now'] = $S['now'];
$GLOBALS['updraftplus'] = null;
function get_plugins() { global $S; return $S['plugins']; }
function is_plugin_active($f) { global $S; return in_array($f, $S['active'], true); }
function activate_plugin($f) { return null; }
function is_wp_error($x) { return false; }
function get_option($k, $d = false) { return array_key_exists($k, $GLOBALS['__opts']) ? $GLOBALS['__opts'][$k] : $d; }
function update_option($k, $v) { $GLOBALS['__opts'][$k] = $v; return true; }
function add_option($k, $v) { if (array_key_exists($k, $GLOBALS['__opts'])) return false; $GLOBALS['__opts'][$k] = $v; return true; }
function wp_get_schedules() { return array('fortnightly' => array('interval' => 1209600), 'monthly' => array('interval' => 2592000), 'weekly' => array('interval' => 604800)); }
function wp_clear_scheduled_hook($h) { unset($GLOBALS['__cron'][$h]); return 0; }
function wp_next_scheduled($h) { return isset($GLOBALS['__cron'][$h]) ? $GLOBALS['__cron'][$h]['ts'] : false; }
function wp_schedule_event($ts, $rec, $h) { $GLOBALS['__cron'][$h] = array('ts' => $ts, 'rec' => $rec); return true; }
function __now() { return $GLOBALS['__now']; }
$code = str_replace('time()', '__now()', file_get_contents($argv[2]));
$result = eval($code);
echo json_encode(array('result' => json_decode($result, true), 'options' => $GLOBALS['__opts'], 'cron' => $GLOBALS['__cron']));
