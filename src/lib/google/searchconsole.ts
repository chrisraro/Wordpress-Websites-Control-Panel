import { getAccessToken } from "./auth";

/**
 * Search Console's Search Analytics API.
 *
 * One request returns totals; a second, dimensioned request returns the
 * breakdown. They are separate calls because Google does not return a totals
 * row alongside dimensioned rows, and summing the rows is wrong: rows are
 * capped at rowLimit, and impressions for a query and for a page double-count
 * the same impression. Deriving the headline from the rows would understate
 * traffic on every site with more than `rowLimit` queries.
 */

export interface GscTotals {
  clicks: number; impressions: number; ctr: number; position: number;
}
export interface GscRow {
  key: string; clicks: number; impressions: number; ctr: number; position: number;
}
export interface GscPerformance {
  property: string;
  start_date: string;
  end_date: string;
  totals: GscTotals;
  queries: GscRow[];
  pages: GscRow[];
}

const API = "https://www.googleapis.com/webmasters/v3/sites";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Rows out of a searchAnalytics response, whatever dimension was asked for. */
export function normalizeRows(raw: unknown): GscRow[] {
  const rows = (raw as { rows?: unknown[] })?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const x = (r ?? {}) as Record<string, unknown>;
    const keys = Array.isArray(x.keys) ? x.keys : [];
    return {
      key: typeof keys[0] === "string" ? keys[0] : "",
      clicks: num(x.clicks),
      impressions: num(x.impressions),
      ctr: num(x.ctr),
      position: num(x.position),
    };
  }).filter((r) => r.key !== "");
}

export function normalizeTotals(raw: unknown): GscTotals {
  const [first] = normalizeRows(raw);
  // An undimensioned query returns exactly one row and no keys, so
  // normalizeRows' key filter would drop it. Read the row directly.
  const rows = (raw as { rows?: unknown[] })?.rows;
  const r = (Array.isArray(rows) ? rows[0] : undefined) as Record<string, unknown> | undefined;
  if (!r) return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  void first;
  return {
    clicks: num(r.clicks), impressions: num(r.impressions),
    ctr: num(r.ctr), position: num(r.position),
  };
}

async function query(
  token: string, property: string, body: Record<string, unknown>, fetchImpl: typeof fetch,
): Promise<unknown> {
  // The property is a path segment and may be "sc-domain:example.com" or a
  // full URL; both must be encoded whole or the colons and slashes break it.
  const url = `${API}/${encodeURIComponent(property)}/searchAnalytics/query`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // 403 here almost always means the service account was never added as a
    // user on the property -- by far the most common setup mistake, and worth
    // naming rather than leaving as a status code.
    const hint = res.status === 403
      ? " The service account may not have been added as a user on this property in Search Console."
      : "";
    throw new Error(`Search Console ${res.status} for ${property}: ${text.slice(0, 200)}${hint}`);
  }
  return JSON.parse(text);
}

/**
 * `undefined` when no service account is configured -- the caller records
 * the source as skipped rather than failed, exactly like the Wordfence feed.
 */
export async function fetchSearchConsole(
  property: string, startDate: string, endDate: string,
  fetchImpl: typeof fetch = fetch, rowLimit = 25,
): Promise<GscPerformance | undefined> {
  const token = await getAccessToken(fetchImpl);
  if (!token) return undefined;

  const range = { startDate, endDate };
  const [totalsRaw, queriesRaw, pagesRaw] = await Promise.all([
    query(token, property, range, fetchImpl),
    query(token, property, { ...range, dimensions: ["query"], rowLimit }, fetchImpl),
    query(token, property, { ...range, dimensions: ["page"], rowLimit }, fetchImpl),
  ]);

  return {
    property,
    start_date: startDate,
    end_date: endDate,
    totals: normalizeTotals(totalsRaw),
    queries: normalizeRows(queriesRaw),
    pages: normalizeRows(pagesRaw),
  };
}
