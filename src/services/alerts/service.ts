import type { SupabaseClient } from "@supabase/supabase-js";
import { getOptionalEnv } from "@/lib/env";
import { evaluateAlerts } from "./evaluate";
import { supabaseAlertsRepo, type AlertsRepo } from "./repo";
import { alertConfig, sendAlerts, type AlertConfig } from "./send";

export type { AlertsRepo } from "./repo";

export interface AlertRunResult {
  /** Alerts delivered to n8n this run. */
  sent: number;
  error: string | null;
}

export interface AlertRunDeps {
  repo: AlertsRepo;
  config: AlertConfig | null;
  appUrl: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
  log?: Pick<Console, "info" | "error">;
}

/**
 * Load → evaluate → send one request → record. Recording happens only after
 * n8n accepted the request: a failed send throws and nothing is recorded, so
 * the next run (5 minutes later) tries the same alerts again. A failure to
 * record after a successful send is reported, not thrown -- the email is out,
 * and the worst case is one duplicate on the next run.
 */
export async function runAlerts(deps: AlertRunDeps): Promise<AlertRunResult> {
  const log = deps.log ?? console;
  if (!deps.config) {
    log.info("alerts: N8N_ALERT_WEBHOOK_URL / N8N_ALERT_SECRET not set; alerting is off");
    return { sent: 0, error: null };
  }
  const now = deps.now ?? new Date();
  const state = await deps.repo.loadState(now);
  const alerts = evaluateAlerts({ ...state, now, appUrl: deps.appUrl });
  if (alerts.length === 0) return { sent: 0, error: null };

  await sendAlerts(alerts, { config: deps.config, fetchImpl: deps.fetchImpl });
  try {
    await deps.repo.recordSent(alerts);
  } catch (e) {
    log.error("alerts: sent but failed to record", e);
    return { sent: alerts.length, error: "alerts sent but failed to record; they may repeat next run" };
  }
  return { sent: alerts.length, error: null };
}

/** The production wiring used by /api/cron/uptime. */
export function runScheduledAlerts(db: SupabaseClient): Promise<AlertRunResult> {
  return runAlerts({
    repo: supabaseAlertsRepo(db),
    config: alertConfig(),
    appUrl: getOptionalEnv("APP_URL") ?? null,
  });
}
