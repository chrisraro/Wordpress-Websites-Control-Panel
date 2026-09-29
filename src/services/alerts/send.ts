import { ALERT_KINDS, type Alert, type AlertKind, type AlertPayload } from "./types";

/** Contract with the n8n alert workflow: give up after 15s. */
export const ALERT_TIMEOUT_MS = 15_000;
export const SUBJECT_PREFIX = "[WP Panel]";

export interface AlertConfig {
  url: string;
  secret: string;
}

/** Both N8N_ALERT_WEBHOOK_URL and N8N_ALERT_SECRET, or null (alerting off). */
export function alertConfig(env: Record<string, string | undefined> = process.env): AlertConfig | null {
  const url = env.N8N_ALERT_WEBHOOK_URL?.trim();
  const secret = env.N8N_ALERT_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const SUBJECT_PHRASE: Record<AlertKind, (n: number) => string> = {
  site_down: (n) => `${plural(n, "site", "sites")} down`,
  site_recovered: (n) => `${plural(n, "site", "sites")} recovered`,
  ssl_expiring: (n) => `${plural(n, "SSL certificate", "SSL certificates")} expiring`,
  critical_vulnerability: (n) => plural(n, "critical vulnerability", "critical vulnerabilities"),
  jobs_failed: (n) => `failed jobs on ${plural(n, "site", "sites")}`,
};

const HEADING: Record<AlertKind, string> = {
  site_down: "Sites down",
  site_recovered: "Sites recovered",
  ssl_expiring: "SSL certificates expiring",
  critical_vulnerability: "Critical vulnerabilities",
  jobs_failed: "Failed jobs",
};

/**
 * The request body n8n turns into an email. Only kind, site name and message
 * leave the panel -- no ids, dedupe keys or credentials.
 */
export function buildAlertPayload(alerts: Alert[], opts: { dryRun?: boolean } = {}): AlertPayload {
  const present = ALERT_KINDS
    .map((kind) => ({ kind, items: alerts.filter((a) => a.kind === kind) }))
    .filter((g) => g.items.length > 0);
  const subject = `${SUBJECT_PREFIX} ${present.map((g) => SUBJECT_PHRASE[g.kind](g.items.length)).join(", ")}`;
  const text = present
    .map((g) => `${HEADING[g.kind]}\n${g.items.map((a) => `- ${a.message}`).join("\n")}`)
    .join("\n\n");
  return {
    subject,
    text,
    alerts: alerts.map((a) => ({ kind: a.kind, site: a.site, message: a.message })),
    dry_run: opts.dryRun ?? false,
  };
}

export type SendResult = { sent: true } | { sent: false; reason: "not_configured" | "nothing_to_send" };

/**
 * One POST per run with every new alert. Throws when n8n does not accept the
 * request, so the caller does not record the alerts as sent and the next run
 * retries them. Error messages never contain the webhook URL or secret.
 */
export async function sendAlerts(
  alerts: Alert[],
  deps: { config: AlertConfig | null; fetchImpl?: typeof fetch; dryRun?: boolean },
): Promise<SendResult> {
  if (!deps.config) return { sent: false, reason: "not_configured" };
  if (alerts.length === 0) return { sent: false, reason: "nothing_to_send" };
  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(deps.config.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ocs-shared-secret": deps.config.secret },
      body: JSON.stringify(buildAlertPayload(alerts, { dryRun: deps.dryRun })),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error";
    throw new Error(`alert webhook request failed (${name === "TimeoutError" ? "timed out" : name})`);
  }
  if (!res.ok) throw new Error(`alert webhook rejected the request: HTTP ${res.status}`);
  return { sent: true };
}
