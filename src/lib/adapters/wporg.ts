export interface WpOrgPlugin {
  slug: string; name: string; version: string; author: string;
  rating: number; num_ratings: number; active_installs: number;
  short_description: string; icon: string | null;
  requires: string | null; tested: string | null; requires_php: string | null;
}
export interface WpOrgSearchResult { plugins: WpOrgPlugin[]; total: number; pages: number }

const API = "https://api.wordpress.org/plugins/info/1.2/";
const FIELDS =
  "&request[fields][icons]=true&request[fields][active_installs]=true&request[fields][short_description]=true";

function stripHtml(s: unknown): string {
  return String(s ?? "").replace(/<[^>]*>/g, "").trim();
}
function orNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function normalize(raw: unknown): WpOrgSearchResult {
  const r = raw as {
    info?: { pages?: number; results?: number };
    plugins?: Array<Record<string, unknown>>;
  };
  const plugins = (r.plugins ?? []).map((p): WpOrgPlugin => {
    const icons = (p.icons ?? {}) as Record<string, string>;
    return {
      slug: String(p.slug ?? ""),
      name: stripHtml(p.name),
      version: String(p.version ?? ""),
      author: stripHtml(p.author),
      rating: Number(p.rating ?? 0),
      num_ratings: Number(p.num_ratings ?? 0),
      active_installs: Number(p.active_installs ?? 0),
      short_description: stripHtml(p.short_description),
      icon: icons["2x"] ?? icons["1x"] ?? icons.svg ?? icons.default ?? null,
      requires: orNull(p.requires),
      tested: orNull(p.tested),
      requires_php: orNull(p.requires_php),
    };
  }).filter((p) => p.slug);
  return { plugins, total: Number(r.info?.results ?? plugins.length), pages: Number(r.info?.pages ?? 1) };
}

async function query(params: URLSearchParams, fetchImpl: typeof fetch): Promise<WpOrgSearchResult> {
  const url = `${API}?action=query_plugins&${params.toString()}${FIELDS}`;
  const res = await fetchImpl(url, { next: { revalidate: 3600 } } as RequestInit);
  if (!res.ok) throw new Error(`wordpress.org plugin API failed: HTTP ${res.status}`);
  return normalize(await res.json());
}

export async function searchPlugins(
  q: string, page = 1, fetchImpl: typeof fetch = fetch,
): Promise<WpOrgSearchResult> {
  const params = new URLSearchParams();
  params.set("request[search]", q);
  params.set("request[page]", String(page));
  params.set("request[per_page]", "24");
  return query(params, fetchImpl);
}

export async function popularPlugins(
  page = 1, fetchImpl: typeof fetch = fetch,
): Promise<WpOrgSearchResult> {
  const params = new URLSearchParams();
  params.set("request[browse]", "popular");
  params.set("request[page]", String(page));
  params.set("request[per_page]", "24");
  return query(params, fetchImpl);
}

export interface WpOrgTheme {
  slug: string;
  name: string;
  version: string;
  author: string;
  preview_url: string | null;
  screenshot_url: string | null;
  rating: number;
  num_ratings: number;
  active_installs: number;
}
export interface WpOrgThemeResult { themes: WpOrgTheme[]; total: number }

const THEMES_API = "https://api.wordpress.org/themes/info/1.2/";

const THEME_FIELDS = {
  slug: true, name: true, version: true, author: true, screenshot_url: true,
  rating: true, num_ratings: true, active_installs: true, preview_url: true,
  sections: false, description: false, tags: false, homepage: false,
};

interface RawTheme {
  slug: string; name: string; version: string;
  author: string | { display_name?: string; user_nicename?: string };
  screenshot_url?: string; preview_url?: string;
  rating?: number; num_ratings?: number; active_installs?: number;
}

/** The themes endpoint returns an author object; the plugins one a string.
 *  Exported so the normalisation can be tested without a network call. */
export function authorName(a: RawTheme["author"]): string {
  if (typeof a === "string") return a.replace(/<[^>]*>/g, "").trim();
  return String(a?.display_name ?? a?.user_nicename ?? "Unknown").trim();
}

function normaliseTheme(t: RawTheme): WpOrgTheme {
  return {
    slug: t.slug,
    name: t.name,
    version: t.version,
    author: authorName(t.author),
    // The API returns protocol-relative URLs ("//ts.w.org/..."), which break
    // in an <img src> on some browsers; force https.
    screenshot_url: t.screenshot_url ? t.screenshot_url.replace(/^\/\//, "https://") : null,
    preview_url: t.preview_url ?? null,
    rating: t.rating ?? 0,
    num_ratings: t.num_ratings ?? 0,
    active_installs: t.active_installs ?? 0,
  };
}

async function queryThemes(params: Record<string, unknown>): Promise<WpOrgThemeResult> {
  const url = `${THEMES_API}?action=query_themes&request=${encodeURIComponent(
    JSON.stringify({ per_page: 24, fields: THEME_FIELDS, ...params }),
  )}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`wordpress.org returned HTTP ${res.status}`);
  const json = (await res.json()) as { themes?: RawTheme[]; info?: { results?: number } };
  return {
    themes: (json.themes ?? []).map(normaliseTheme),
    total: json.info?.results ?? 0,
  };
}

export const searchThemes = (q: string) => queryThemes({ search: q });
export const popularThemes = () => queryThemes({ browse: "popular" });
