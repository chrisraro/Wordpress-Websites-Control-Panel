import tls from "node:tls";
import type { UptimeRow } from "./types";

export function sslDaysRemaining(hostname: string): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, timeout: 10_000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) return resolve(null);
        const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
        resolve(Number.isFinite(days) ? days : null);
      },
    );
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

export async function checkSite(
  url: string, fetchImpl: typeof fetch = fetch,
): Promise<Omit<UptimeRow, "site_id">> {
  const started = Date.now();
  let status: number | null = null;
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "wp-control-panel-uptime/1.0" },
    });
    status = res.status;
  } catch {
    status = null;
  }
  const response_ms = Date.now() - started;
  let ssl_days_remaining: number | null = null;
  if (url.startsWith("https://")) {
    try {
      ssl_days_remaining = await sslDaysRemaining(new URL(url).hostname);
    } catch {
      ssl_days_remaining = null;
    }
  }
  return {
    http_status: status,
    response_ms,
    ssl_days_remaining,
    ok: status !== null && status >= 200 && status < 400,
  };
}
