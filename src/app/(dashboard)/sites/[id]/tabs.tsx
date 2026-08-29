import Link from "next/link";
import {
  IconMap, IconOverview, IconPlugins, IconReport, IconSearch, IconShield, IconThemes,
} from "@/components/ui/icons";

const LIVE = [
  { key: "overview", label: "Overview", Icon: IconOverview, href: (id: string) => `/sites/${id}` },
  { key: "plugins", label: "Plugins", Icon: IconPlugins, href: (id: string) => `/sites/${id}/plugins` },
  { key: "themes", label: "Themes", Icon: IconThemes, href: (id: string) => `/sites/${id}/themes` },
  { key: "security", label: "Security", Icon: IconShield, href: (id: string) => `/sites/${id}/security` },
  { key: "seo", label: "SEO", Icon: IconSearch, href: (id: string) => `/sites/${id}/seo` },
  { key: "geogrid", label: "GeoGrid", Icon: IconMap, href: (id: string) => `/sites/${id}/geogrid` },
  { key: "reports", label: "Reports", Icon: IconReport, href: (id: string) => `/sites/${id}/reports` },
] as const;

export type SiteTabKey = (typeof LIVE)[number]["key"];

/**
 * Segmented control rather than an underlined tab row: the active section
 * rides on a paper pill, which keeps the whole strip inside the system's
 * pill geometry and survives horizontal scrolling on a phone.
 */
export function SiteTabs({ siteId, active }: { siteId: string; active: SiteTabKey }) {
  return (
    <nav aria-label="Site sections" className="mb-6 -mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex w-max min-w-full gap-1 rounded-3xl bg-canvas p-1">
        {LIVE.map(({ key, label, Icon, href }) => {
          const isActive = active === key;
          return (
            <li key={key}>
              <Link
                href={href(siteId)}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-9 items-center gap-2 whitespace-nowrap rounded-2xl px-3
                  text-body transition-colors duration-150 ${
                    isActive
                      ? "bg-paper font-medium text-ink shadow-subtle"
                      : "text-mid-gray hover:text-ink"
                  }`}
              >
                <Icon size={16} className="shrink-0" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
