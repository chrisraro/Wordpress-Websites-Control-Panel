import { clampToLastPage, parsePage } from "@/lib/pagination";
import { SEVERITY_RANK, type Severity } from "./portfolio";
import type { SiteEnvironment, SiteStatus } from "./types";

/**
 * The dashboard's site directory: search, environment filter, sort and
 * paging, as pure functions over rows the page has already loaded.
 *
 * Everything lives in the URL (`?q=&env=&sort=&page=`), so a filtered view
 * survives a reload, can be sent to a colleague and works before hydration.
 * Every value is parsed here rather than trusted: an unknown sort or
 * environment falls back to the default instead of reaching the page.
 */

export type DirectoryEnv = "all" | "live" | "staging";
export type DirectorySort = "attention" | "name" | "live" | "staging" | "grade" | "updates" | "uptime";

/** Nine fills a three-column grid exactly. */
export const DIRECTORY_PAGE_SIZE = 9;
const MAX_QUERY_LENGTH = 100;

export const DIRECTORY_SORT_LABEL: Record<DirectorySort, string> = {
  name: "Name A–Z",
  attention: "Needs attention first",
  live: "Live first",
  staging: "Staging first",
  grade: "Worst security grade",
  updates: "Most updates",
  uptime: "Lowest uptime",
};

export const DIRECTORY_ENV_LABEL: Record<DirectoryEnv, string> = {
  all: "All sites",
  live: "Live",
  staging: "Staging",
};

export interface DirectoryQuery {
  q: string;
  env: DirectoryEnv;
  sort: DirectorySort;
  page: number;
}

/** What the directory needs to know about one site to search, sort and summarise it. */
export interface DirectoryFields {
  id: string;
  name: string;
  url: string;
  clientLabel: string | null;
  env: SiteEnvironment;
  status: SiteStatus;
  severity: Severity;
  grade?: string;
  updates?: number;
  seo?: number;
  /** Confirmed up/down (see liveness); null/undefined = unknown. */
  up?: boolean | null;
  /** The newest check failed but the site is not yet confirmed down. */
  downUnconfirmed?: boolean;
  uptime24h?: number | null;
  sslDays?: number | null;
  /** On a staging row: the production site it was explicitly paired with (0026). */
  pairOf?: string | null;
}

type RawParam = string | string[] | undefined;
const first = (v: RawParam) => (Array.isArray(v) ? v[0] : v);

function parseEnv(raw: RawParam): DirectoryEnv {
  const v = first(raw);
  // "production" is what the old Production/Staging tabs put in the URL.
  if (v === "live" || v === "production") return "live";
  if (v === "staging") return "staging";
  return "all";
}

function parseSort(raw: RawParam): DirectorySort {
  const v = first(raw);
  return v !== undefined && Object.hasOwn(DIRECTORY_SORT_LABEL, v) ? (v as DirectorySort) : "name";
}

export function parseDirectoryQuery(params: {
  q?: RawParam; env?: RawParam; sort?: RawParam; page?: RawParam;
}): DirectoryQuery {
  return {
    q: (first(params.q) ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    env: parseEnv(params.env),
    sort: parseSort(params.sort),
    page: parsePage(params.page),
  };
}

const bareUrl = (url: string) => url.replace(/^https?:\/\//i, "").toLowerCase();

function matches(f: DirectoryFields, needle: string): boolean {
  if (!needle) return true;
  return f.name.toLowerCase().includes(needle)
    || bareUrl(f.url).includes(needle)
    || (f.clientLabel ?? "").toLowerCase().includes(needle);
}

const GRADE_RANK: Record<string, number> = { F: 0, D: 1, C: 2, B: 3, A: 4 };
const UNMEASURED = Number.POSITIVE_INFINITY;

/** Lower sorts first. Unmeasured values always sort last. */
function sortKey(f: DirectoryFields, sort: DirectorySort): number {
  switch (sort) {
    case "attention": return SEVERITY_RANK[f.severity];
    case "live": return f.env === "production" ? 0 : 1;
    case "staging": return f.env === "staging" ? 0 : 1;
    case "grade": return f.grade !== undefined ? (GRADE_RANK[f.grade] ?? UNMEASURED) : UNMEASURED;
    case "updates": return f.updates !== undefined ? -f.updates : UNMEASURED;
    case "uptime": return typeof f.uptime24h === "number" ? f.uptime24h : UNMEASURED;
    case "name": return 0;
  }
}

/** Explicit, so two unmeasured (Infinity) keys tie instead of yielding NaN. */
function compareKeys(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Hostname without www. and without leading staging/stage/dev labels. */
function familyHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
      .replace(/^www\./, "")
      .replace(/^(?:(?:staging|stage|stg|dev|test)\d*\.)+/, "");
  } catch {
    return null;
  }
}

/** Name without staging words and punctuation, for name-based pairing. */
function familyName(name: string): string {
  return name.toLowerCase()
    .replace(/\b(?:staging|stage|stg|dev|test|copy)\d*\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Which live site each staging copy belongs to, so the directory can put the
 * two side by side. The operator's explicit pairing (0026) wins; without it
 * the copy is matched by host (staging.example.com -> example.com), then by
 * name ("Example Staging" -> "Example"). Only staging rows get a pair, and
 * only ever to a production row, so a guess can never merge two live sites.
 */
export function resolvePairs(sites: readonly DirectoryFields[]): Map<string, string> {
  const live = sites.filter((s) => s.env === "production");
  const liveIds = new Set(live.map((s) => s.id));
  const byHost = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const s of live) {
    const host = familyHost(s.url);
    if (host && !byHost.has(host)) byHost.set(host, s.id);
    const n = familyName(s.name);
    if (n && !byName.has(n)) byName.set(n, s.id);
  }
  const pairs = new Map<string, string>();
  for (const s of sites) {
    if (s.env !== "staging") continue;
    const host = familyHost(s.url);
    const match = (s.pairOf && liveIds.has(s.pairOf) ? s.pairOf : undefined)
      ?? (host ? byHost.get(host) : undefined)
      ?? byName.get(familyName(s.name));
    if (match) pairs.set(s.id, match);
  }
  return pairs;
}

export interface DirectoryPage<T> {
  items: T[];
  page: number;
  totalPages: number;
  /** Matches across all pages, after search and filter. */
  total: number;
}

export function queryDirectory<T>(
  rows: readonly T[], fields: (row: T) => DirectoryFields, query: DirectoryQuery,
  pageSize: number = DIRECTORY_PAGE_SIZE,
): DirectoryPage<T> {
  const needle = bareUrl(query.q);
  const visible = rows
    .map((row) => ({ row, f: fields(row) }))
    .filter(({ f }) => matches(f, needle))
    .filter(({ f }) =>
      query.env === "all" || (query.env === "live" ? f.env === "production" : f.env === "staging"));

  // A-Z keeps each staging copy right after its live site: both sort under
  // the live site's name, live first. Only when that live site is on screen
  // too -- otherwise the copy sorts under its own name.
  const pairs = resolvePairs(visible.map(({ f }) => f));
  const nameOf = new Map(visible.map(({ f }) => [f.id, f.name]));
  const groupName = (f: DirectoryFields) => {
    const partner = pairs.get(f.id);
    return (partner && nameOf.get(partner)) ?? f.name;
  };
  const byName = (a: DirectoryFields, b: DirectoryFields) =>
    groupName(a).localeCompare(groupName(b))
    || compareKeys(a.env === "staging" ? 1 : 0, b.env === "staging" ? 1 : 0)
    || a.name.localeCompare(b.name);

  const filtered = visible.sort((a, b) =>
    compareKeys(sortKey(a.f, query.sort), sortKey(b.f, query.sort)) || byName(a.f, b.f));

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = clampToLastPage(query.page, totalPages);
  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize).map(({ row }) => row),
    page,
    totalPages,
    total: filtered.length,
  };
}

/**
 * A link to the directory with some of the query changed. Defaults and page 1
 * are left out so the plain view keeps its plain URL; `#sites` lands the
 * reader on the directory rather than back at the top of the overview.
 */
export function directoryHref(query: DirectoryQuery, change: Partial<DirectoryQuery>): string {
  const next = { ...query, ...change };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.env !== "all") params.set("env", next.env);
  if (next.sort !== "name") params.set("sort", next.sort);
  if (next.page > 1) params.set("page", String(next.page));
  const qs = params.toString();
  return `/dashboard${qs ? `?${qs}` : ""}#sites`;
}
