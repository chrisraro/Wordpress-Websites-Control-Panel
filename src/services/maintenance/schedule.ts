import type { MaintenanceRepo } from "./repo";
import { scheduleIntoWindows } from "./window";

/**
 * "Run now" vs "In each site's maintenance window" for bulk and fleet
 * enqueues. The choice arrives from a form; anything but the literal
 * "window" means now, so a tampered value can only ever make work run
 * sooner under the operator's own eyes, never silently later.
 */
export type Timing = "now" | "window";

export function parseTiming(fd: FormData | undefined | null): Timing {
  return fd?.get("timing") === "window" ? "window" : "now";
}

export async function planTiming(
  repo: Pick<MaintenanceRepo, "listWindows">, siteIds: string[], timing: Timing, now: Date,
): Promise<{ scheduledFor: Map<string, string>; windowed: number }> {
  if (timing === "now" || siteIds.length === 0) return { scheduledFor: new Map(), windowed: 0 };
  const windows = await repo.listWindows(siteIds);
  const scheduledFor = scheduleIntoWindows(siteIds, windows, now);
  return { scheduledFor, windowed: scheduledFor.size };
}

/**
 * A sentence appended to "Queued … for N sites." so the toast says which
 * sites are waiting. Empty when nothing waits -- including a window run
 * where no site has a window (or every window is open now).
 */
export function timingNote(total: number, windowed: number, timing: Timing): string {
  if (timing === "now" || windowed === 0) return "";
  if (windowed >= total) return " All will wait for their maintenance window.";
  return ` ${windowed} will wait for their maintenance window; ${total - windowed} run${total - windowed === 1 ? "s" : ""} now.`;
}
