import { describe, it, expect, vi } from "vitest";
import { alertConfig, buildAlertPayload, sendAlerts, ALERT_TIMEOUT_MS } from "@/services/alerts/send";
import type { Alert } from "@/services/alerts/types";

const down = (site: string): Alert => ({
  kind: "site_down", site_id: `id-${site}`, site, message: `${site} is down.`, keys: ["k"],
});
const vuln: Alert = {
  kind: "critical_vulnerability", site_id: "id-a", site: "Alpha", message: "Alpha: critical vuln.", keys: ["v1"],
};
const CONFIG = { url: "https://n8n.test/webhook/abc", secret: "s3cret-value" };

function okFetch() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 200 }));
}

describe("alertConfig", () => {
  it("is null when either env var is unset or empty", () => {
    expect(alertConfig({})).toBeNull();
    expect(alertConfig({ N8N_ALERT_WEBHOOK_URL: "https://n8n.test/x" })).toBeNull();
    expect(alertConfig({ N8N_ALERT_SECRET: "s" })).toBeNull();
    expect(alertConfig({ N8N_ALERT_WEBHOOK_URL: "", N8N_ALERT_SECRET: "s" })).toBeNull();
  });

  it("returns both values when set", () => {
    expect(alertConfig({ N8N_ALERT_WEBHOOK_URL: "https://n8n.test/x", N8N_ALERT_SECRET: "s" }))
      .toEqual({ url: "https://n8n.test/x", secret: "s" });
  });
});

describe("buildAlertPayload", () => {
  it("summarises counts per kind in the subject", () => {
    const p = buildAlertPayload([down("Alpha"), down("Beta"), vuln]);
    expect(p.subject).toBe("[WP Panel] 2 sites down, 1 critical vulnerability");
  });

  it("uses singular and plural forms for every kind", () => {
    const one = (kind: Alert["kind"]): Alert => ({ kind, site_id: null, site: null, message: "m", keys: ["k"] });
    expect(buildAlertPayload([one("site_down")]).subject).toBe("[WP Panel] 1 site down");
    expect(buildAlertPayload([one("site_recovered"), one("site_recovered")]).subject)
      .toBe("[WP Panel] 2 sites recovered");
    expect(buildAlertPayload([one("ssl_expiring")]).subject).toBe("[WP Panel] 1 SSL certificate expiring");
    expect(buildAlertPayload([vuln, vuln]).subject).toBe("[WP Panel] 2 critical vulnerabilities");
    expect(buildAlertPayload([one("jobs_failed")]).subject).toBe("[WP Panel] failed jobs on 1 site");
  });

  it("sends only kind, site and message per alert, never ids or dedupe keys", () => {
    const p = buildAlertPayload([down("Alpha")]);
    expect(p.alerts).toEqual([{ kind: "site_down", site: "Alpha", message: "Alpha is down." }]);
    expect(p.dry_run).toBe(false);
  });

  it("puts every message in the plain-text body", () => {
    const p = buildAlertPayload([down("Alpha"), vuln]);
    expect(p.text).toContain("Alpha is down.");
    expect(p.text).toContain("Alpha: critical vuln.");
  });

  it("can build a dry-run payload", () => {
    expect(buildAlertPayload([down("Alpha")], { dryRun: true }).dry_run).toBe(true);
  });
});

describe("sendAlerts", () => {
  it("is a no-op without configuration", async () => {
    const fetchImpl = okFetch();
    const r = await sendAlerts([down("Alpha")], { config: null, fetchImpl });
    expect(r).toEqual({ sent: false, reason: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("makes no request when there are no alerts", async () => {
    const fetchImpl = okFetch();
    const r = await sendAlerts([], { config: CONFIG, fetchImpl });
    expect(r).toEqual({ sent: false, reason: "nothing_to_send" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs one JSON request with the shared-secret header and a timeout", async () => {
    const fetchImpl = okFetch();
    const r = await sendAlerts([down("Alpha"), vuln], { config: CONFIG, fetchImpl });
    expect(r).toEqual({ sent: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(CONFIG.url);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-ocs-shared-secret")).toBe("s3cret-value");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body.subject).toBe("[WP Panel] 1 site down, 1 critical vulnerability");
    expect(body.alerts).toHaveLength(2);
    expect(body.dry_run).toBe(false);
    expect(ALERT_TIMEOUT_MS).toBe(15_000);
  });

  it("throws on a non-2xx response without leaking the secret or webhook URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const err = await sendAlerts([down("Alpha")], { config: CONFIG, fetchImpl }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("500");
    expect((err as Error).message).not.toContain("s3cret");
    expect((err as Error).message).not.toContain("n8n.test");
  });

  it("wraps a network failure without leaking the webhook URL", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed https://n8n.test/webhook/abc"); });
    const err = await sendAlerts([down("Alpha")], { config: CONFIG, fetchImpl }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/alert webhook/i);
    expect((err as Error).message).not.toContain("n8n.test");
  });
});
