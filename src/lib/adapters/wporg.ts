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
