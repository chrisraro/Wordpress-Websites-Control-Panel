/**
 * Weekly SEO cadence, checked by the nightly enqueue.
 *
 * lastRunAt is when the previous scan *finished* -- minutes after that
 * night's enqueue -- so exactly one week later it is a few minutes short of
 * seven days old. A strict 7-day cutoff would skip that night and run on day
 * eight, every week. 6.5 days absorbs the scan's own duration while still
 * never running twice in a week from a nightly schedule.
 */
export const SEO_RESCAN_AFTER_MS = 6.5 * 24 * 3600 * 1000;

export function isSeoScanDue(lastRunAt: string | null, now: number = Date.now()): boolean {
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now - last >= SEO_RESCAN_AFTER_MS;
}
