import { getAccessToken } from "./auth";

/**
 * The GA4 Data API (runReport).
 *
 * Deliberately reports on a *property id*, not the G-XXXXXXX measurement id
 * visible in a page's source. They are easy to confuse and not
 * interchangeable: a measurement id names one data stream, a property id
 * names the thing the API reports on. Two sites in this fleet already share
 * a measurement id, so deriving the property from the page would have merged
 * them into one set of numbers.
 */

export interface Ga4Totals {
  users: number; sessions: number; engagedSessions: number; views: number;
}
export interface Ga4Channel { channel: string; sessions: number; users: number }
export interface Ga4Traffic {
  property_id: string;
  start_date: string;
  end_date: string;
  totals: Ga4Totals;
  channels: Ga4Channel[];
}

const API = "https://analyticsdata.googleapis.com/v1beta/properties";

/** GA4 returns every metric as a string, including counts. */
const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const metricAt = (row: unknown, i: number): number =>
  num(((row as { metricValues?: unknown[] })?.metricValues?.[i] as { value?: unknown })?.value);

export function normalizeTotals(raw: unknown): Ga4Totals {
  const row = (raw as { rows?: unknown[] })?.rows?.[0];
  if (!row) return { users: 0, sessions: 0, engagedSessions: 0, views: 0 };
  return {
    users: metricAt(row, 0),
    sessions: metricAt(row, 1),
    engagedSessions: metricAt(row, 2),
    views: metricAt(row, 3),
  };
}

export function normalizeChannels(raw: unknown): Ga4Channel[] {
  const rows = (raw as { rows?: unknown[] })?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const dim = ((r as { dimensionValues?: unknown[] })?.dimensionValues?.[0] as { value?: unknown })?.value;
    return {
      channel: typeof dim === "string" && dim ? dim : "Unassigned",
      sessions: metricAt(r, 0),
      users: metricAt(r, 1),
    };
  });
}

async function runReport(
  token: string, propertyId: string, body: Record<string, unknown>, fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${API}/${encodeURIComponent(propertyId)}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // 403 here is nearly always the service account missing from Property
    // Access Management -- the one setup step people skip.
    const hint = res.status === 403
      ? " The service account may not have been added as a Viewer on this GA4 property."
      : "";
    throw new Error(`GA4 ${res.status} for property ${propertyId}: ${text.slice(0, 200)}${hint}`);
  }
  return JSON.parse(text);
}

export async function fetchGa4Traffic(
  propertyId: string, startDate: string, endDate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Ga4Traffic | undefined> {
  const token = await getAccessToken(fetchImpl);
  if (!token) return undefined;

  const dateRanges = [{ startDate, endDate }];
  // Metric order is load-bearing: the normalizers read metricValues
  // positionally, because GA4 does not label them in the row.
  const metrics = [
    { name: "totalUsers" }, { name: "sessions" },
    { name: "engagedSessions" }, { name: "screenPageViews" },
  ];

  const [totalsRaw, channelsRaw] = await Promise.all([
    runReport(token, propertyId, { dateRanges, metrics }, fetchImpl),
    runReport(token, propertyId, {
      dateRanges,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 10,
    }, fetchImpl),
  ]);

  return {
    property_id: propertyId,
    start_date: startDate,
    end_date: endDate,
    totals: normalizeTotals(totalsRaw),
    channels: normalizeChannels(channelsRaw),
  };
}
