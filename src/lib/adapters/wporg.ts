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

/**
 * wordpress.org returns display titles HTML-encoded — "Yoast SEO &#8211;
 * Advanced SEO" — and React renders a string as text, so an undecoded entity
 * reaches the user literally. Every plugin or theme whose name contains a
 * dash, ampersand or ellipsis was showing its entity on the marketplace.
 *
 * Decoding is safe here precisely because the result is rendered as text:
 * React escapes it on the way out, so turning "&lt;script&gt;" back into
 * "<script>" produces visible characters, never markup. Do not pass the
 * result to dangerouslySetInnerHTML.
 *
 * `&amp;` is decoded last, otherwise "&amp;#8211;" — an escaped literal —
 * would decode twice and silently become a dash the source never contained.
 */
const NAMED_ENTITIES: Record<string, string> = {
  "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#039;": "'",
  "&nbsp;": " ", "&hellip;": "…", "&ndash;": "–", "&mdash;": "—",
  "&lsquo;": "‘", "&rsquo;": "’", "&ldquo;": "“", "&rdquo;": "”",
};

function decodeEntities(s: string): string {
  let out = s.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  out = out.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out.split("&amp;").join("&");
}

function stripHtml(s: unknown): string {
  return decodeEntities(String(s ?? "").replace(/<[^>]*>/g, "")).trim();
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
export interface WpOrgThemeResult { themes: WpOrgTheme[]; total: number; pages: number }

const THEMES_API = "https://api.wordpress.org/themes/info/1.2/";

/**
 * Like the plugins `FIELDS` above, this is the bracketed query-param form,
 * not a JSON blob — `request[fields][x]=...` the same way `request[search]`
 * and `request[page]` are sent. The JSON-blob form (`?request=<json>`) is
 * silently ignored by this API: a search term and a browse filter sent that
 * way both fell through to an unfiltered default listing, which is the
 * critical bug this file fixes.
 *
 * `active_installs` is opt-in — the API omits it by default — while
 * `description`/`sections`/`tags`/`homepage` are opted back OUT: they come
 * back by default and are never rendered on a theme card, so requesting
 * `false` for them keeps the response down to what the grid actually shows.
 * Verified live: the response still carries screenshot_url, preview_url,
 * rating, num_ratings and active_installs with this exact field set.
 */
const THEME_FIELDS =
  "&request[fields][screenshot_url]=true&request[fields][preview_url]=true" +
  "&request[fields][rating]=true&request[fields][num_ratings]=true" +
  "&request[fields][active_installs]=true&request[fields][description]=false" +
  "&request[fields][sections]=false&request[fields][tags]=false" +
  "&request[fields][homepage]=false";

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
    // Themes come back HTML-encoded exactly as plugins do; this path was
    // passing the raw value straight through.
    name: stripHtml(t.name),
    version: t.version,
    author: stripHtml(authorName(t.author)),
    // The API returns protocol-relative URLs ("//ts.w.org/..."), which break
    // in an <img src> on some browsers; force https.
    screenshot_url: t.screenshot_url ? t.screenshot_url.replace(/^\/\//, "https://") : null,
    preview_url: t.preview_url ?? null,
    rating: t.rating ?? 0,
    num_ratings: t.num_ratings ?? 0,
    active_installs: t.active_installs ?? 0,
  };
}

async function queryThemes(
  params: URLSearchParams, fetchImpl: typeof fetch,
): Promise<WpOrgThemeResult> {
  const url = `${THEMES_API}?action=query_themes&${params.toString()}${THEME_FIELDS}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) } as RequestInit);
  if (!res.ok) throw new Error(`wordpress.org returned HTTP ${res.status}`);
  const json = (await res.json()) as {
    themes?: RawTheme[];
    info?: { results?: number; pages?: number };
  };
  return {
    themes: (json.themes ?? []).map(normaliseTheme),
    total: Number(json.info?.results ?? 0),
    pages: Number(json.info?.pages ?? 1),
  };
}

export async function searchThemes(
  q: string, page = 1, fetchImpl: typeof fetch = fetch,
): Promise<WpOrgThemeResult> {
  const params = new URLSearchParams();
  params.set("request[search]", q);
  params.set("request[page]", String(page));
  params.set("request[per_page]", "24");
  return queryThemes(params, fetchImpl);
}

export async function popularThemes(
  page = 1, fetchImpl: typeof fetch = fetch,
): Promise<WpOrgThemeResult> {
  const params = new URLSearchParams();
  params.set("request[browse]", "popular");
  params.set("request[page]", String(page));
  params.set("request[per_page]", "24");
  return queryThemes(params, fetchImpl);
}
