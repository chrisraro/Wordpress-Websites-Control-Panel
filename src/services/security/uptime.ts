import tls from "node:tls";
import { guardedFetch, publicOnlyLookup } from "@/lib/net-guard";
import type { UptimeRow } from "./types";

/**
 * Days until the site's certificate expires; negative once it has expired.
 *
 * Verification is off on purpose: this only reads the certificate's expiry.
 * With Node's default rejectUnauthorized:true an expired or otherwise invalid
 * certificate fails the handshake and would come back as null -- hiding the
 * very case this check exists to flag. Math.floor makes any expired cert
 * strictly negative (-1 as soon as it lapses).
 */
export function sslDaysRemaining(hostname: string): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: hostname, port: 443, servername: hostname, timeout: 10_000, rejectUnauthorized: false,
        // Same connect-time guard as the HTTP probes: a name that now
        // resolves privately is refused at the socket (resolves to null).
        lookup: publicOnlyLookup() as never,
      },
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

/**
 * Whether a response lets the panel frame the page, by the browser's rule:
 * when any CSP sets frame-ancestors, those decide and X-Frame-Options is
 * ignored; each such policy must name `*` or the panel's origin. Without
 * frame-ancestors, any X-Frame-Options blocks us (ALLOW-FROM is obsolete).
 */
export function frameableFrom(headers: Headers, panelOrigin: string | undefined = appOrigin()): boolean {
  const csp = headers.get("content-security-policy");
  const ancestorLists = (csp ?? "")
    // Several CSP headers arrive joined with ", "; each is its own policy.
    .split(",")
    .map((policy) => policy.split(";").map((d) => d.trim()).find((d) => /^frame-ancestors\b/i.test(d)))
    .filter((d): d is string => d !== undefined)
    .map((d) => d.split(/\s+/).slice(1));
  if (ancestorLists.length > 0) {
    return ancestorLists.every((sources) =>
      sources.includes("*") || (panelOrigin !== undefined && sources.includes(panelOrigin)));
  }
  return !headers.get("x-frame-options");
}

function appOrigin(): string | undefined {
  try {
    return process.env.APP_URL ? new URL(process.env.APP_URL).origin : undefined;
  } catch {
    return undefined;
  }
}

export async function checkSite(
  url: string, fetchImpl: typeof fetch = guardedFetch,
): Promise<Omit<UptimeRow, "site_id">> {
  const started = Date.now();
  let status: number | null = null;
  let frameable: boolean | null = null;
  try {
    const res = await fetchImpl(url, {
      // Followed hop by hop by guardedFetch, each hop re-checked; a
      // redirect into private space counts as down.
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "wp-control-panel-uptime/1.0" },
    });
    status = res.status;
    frameable = frameableFrom(res.headers);
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
    frameable,
    ok: status !== null && status >= 200 && status < 400,
  };
}
