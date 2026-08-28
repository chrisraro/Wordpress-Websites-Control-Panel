import Link from "next/link";

const LIVE = [
  { key: "overview", label: "Overview", href: (id: string) => `/sites/${id}` },
  { key: "plugins", label: "Plugins", href: (id: string) => `/sites/${id}/plugins` },
  { key: "themes", label: "Themes", href: (id: string) => `/sites/${id}/themes` },
  { key: "security", label: "Security", href: (id: string) => `/sites/${id}/security` },
  { key: "seo", label: "SEO", href: (id: string) => `/sites/${id}/seo` },
] as const;
const COMING = ["GeoGrid", "Reports"];

export type SiteTabKey = (typeof LIVE)[number]["key"];

export function SiteTabs({ siteId, active }: { siteId: string; active: SiteTabKey }) {
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b">
      {LIVE.map((t) => (
        <Link key={t.key} href={t.href(siteId)}
          aria-current={active === t.key ? "page" : undefined}
          className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm ${active === t.key
            ? "border-b-2 border-slate-900 font-medium"
            : "text-slate-600 hover:text-slate-900"}`}>
          {t.label}
        </Link>
      ))}
      {COMING.map((t) => (
        <span key={t} aria-disabled="true" title="Coming in a later phase"
          className="shrink-0 cursor-not-allowed whitespace-nowrap px-3 py-2 text-sm text-slate-400">
          {t}<span className="sr-only"> (coming in a later phase)</span>
        </span>
      ))}
    </nav>
  );
}
