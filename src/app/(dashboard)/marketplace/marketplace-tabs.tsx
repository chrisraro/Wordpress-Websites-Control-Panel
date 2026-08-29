import Link from "next/link";
import { IconPlugins, IconThemes } from "@/components/ui/icons";

const TABS = [
  { key: "plugins", label: "Plugins", Icon: IconPlugins, href: "/marketplace" },
  { key: "themes", label: "Themes", Icon: IconThemes, href: "/marketplace/themes" },
] as const;

export type MarketplaceTabKey = (typeof TABS)[number]["key"];

/**
 * Segmented control matching `SiteTabs`: a canvas strip with the active
 * section riding on a paper pill, so the plugin/theme switch reads as one
 * system rather than two separately-styled surfaces.
 */
export function MarketplaceTabs({ active }: { active: MarketplaceTabKey }) {
  return (
    <nav aria-label="Marketplace sections" className="mb-6 -mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex w-max min-w-full gap-1 rounded-3xl bg-canvas p-1">
        {TABS.map(({ key, label, Icon, href }) => {
          const isActive = active === key;
          return (
            <li key={key}>
              <Link
                href={href}
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
