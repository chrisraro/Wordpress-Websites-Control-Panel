"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { logout } from "@/app/login/actions";
import { buttonClass, iconButtonClass } from "@/components/ui/styles";
import { SubmitButton } from "@/components/ui/submit-button";
import { SitePalette, SitePaletteTrigger, type PaletteSite } from "./site-palette";
import {
  IconClose, IconLogout, IconMarketplace, IconMenu, IconPlus, IconSites, IconUsers,
} from "@/components/ui/icons";

interface NavItem {
  href: string;
  label: string;
  Icon: typeof IconSites;
  /** Sub-routes that should keep this item lit. */
  match: (pathname: string) => boolean;
}

const NAV: NavItem[] = [
  {
    href: "/dashboard",
    label: "Sites",
    Icon: IconSites,
    match: (p) => p === "/dashboard" || p.startsWith("/sites"),
  },
  {
    href: "/marketplace",
    label: "Marketplace",
    Icon: IconMarketplace,
    match: (p) => p.startsWith("/marketplace"),
  },
  {
    href: "/users",
    label: "Users",
    Icon: IconUsers,
    match: (p) => p.startsWith("/users"),
  },
];

function NavLinks({
  pathname, onNavigate, showMarketplace, showUsers,
}: { pathname: string; onNavigate?: () => void; showMarketplace: boolean; showUsers: boolean }) {
  const items = NAV.filter((item) => {
    if (item.href === "/marketplace") return showMarketplace;
    if (item.href === "/users") return showUsers;
    return true;
  });
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {items.map(({ href, label, Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-10 items-center gap-3 rounded-2xl px-3 text-body transition-colors
              duration-150 pointer-coarse:min-h-11 ${
                active
                  ? "bg-canvas font-medium text-ink"
                  : "text-mid-gray hover:bg-canvas hover:text-ink"
              }`}
          >
            <Icon size={18} className="shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarBody({
  email, pathname, onNavigate, showConnectSite, showMarketplace, showUsers,
  hasSites, onOpenPalette,
}: {
  email: string;
  pathname: string;
  onNavigate?: () => void;
  showConnectSite: boolean;
  showMarketplace: boolean;
  showUsers: boolean;
  hasSites: boolean;
  onOpenPalette: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="flex min-h-8 items-center gap-2 px-3 text-body font-semibold leading-tight tracking-[-0.02em] text-ink pointer-coarse:min-h-11"
      >
        <Image src="/brand/icon-192.png" alt="" width={24} height={24} className="shrink-0" />
        <span>OCS Wordpress Control Panel</span>
      </Link>

      {showConnectSite && (
        <Link
          href="/sites/new"
          onClick={onNavigate}
          className={buttonClass("primary", "md", "w-full")}
        >
          <IconPlus size={16} />
          Connect site
        </Link>
      )}

      {hasSites && <SitePaletteTrigger onOpen={onOpenPalette} />}

      <NavLinks
        pathname={pathname}
        onNavigate={onNavigate}
        showMarketplace={showMarketplace}
        showUsers={showUsers}
      />

      <div className="mt-auto border-t border-hairline pt-4">
        <p className="truncate px-3 text-caption tracking-normal text-mid-gray" title={email}>
          {email}
        </p>
        <form action={logout} className="mt-1">
          <SubmitButton
            label="Sign out"
            pendingLabel="Signing out…"
            icon={<IconLogout size={16} />}
            variant="ghost"
            className={buttonClass("ghost", "md", "w-full justify-start")}
          />
        </form>
      </div>
    </div>
  );
}

export function Sidebar({
  email, showConnectSite, showMarketplace, showUsers, sites,
}: {
  email: string;
  showConnectSite: boolean;
  showMarketplace: boolean;
  showUsers: boolean;
  sites: PaletteSite[];
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // A sheet that survives navigation would cover the page it just opened.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Desktop: a persistent column one tonal step off the canvas. */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-hairline bg-surface-alt lg:block">
        <SidebarBody
          email={email}
          pathname={pathname}
          showConnectSite={showConnectSite}
          hasSites={sites.length > 0}
          onOpenPalette={() => setPaletteOpen(true)}
          showMarketplace={showMarketplace}
          showUsers={showUsers}
        />
      </aside>

      {/* Mobile: slim bar + slide-over sheet. */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-hairline bg-surface-alt/90 px-4 py-3 backdrop-blur-sm lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          className={iconButtonClass("shrink-0")}
        >
          <IconMenu size={20} />
        </button>
        <Link
          href="/dashboard"
          className="flex min-h-8 items-center gap-2 text-body font-semibold tracking-[-0.02em] text-ink pointer-coarse:min-h-11"
        >
          <Image src="/brand/icon-192.png" alt="" width={24} height={24} className="shrink-0" />
          <span>OCS Wordpress Control Panel</span>
        </Link>
      </header>

      <dialog
        ref={dialogRef}
        aria-label="Navigation"
        onCancel={(e) => {
          e.preventDefault();
          setOpen(false);
        }}
        className="fixed inset-0 h-full max-h-full w-full max-w-full bg-transparent lg:hidden"
      >
        <div
          className="animate-backdrop fixed inset-0 bg-ink/25"
          onClick={() => setOpen(false)}
          aria-hidden
        />
        <div className="animate-sheet relative h-full w-72 max-w-[85vw] border-r border-hairline bg-surface-alt">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className={iconButtonClass("absolute right-3 top-3")}
          >
            <IconClose size={18} />
          </button>
          <SidebarBody
            email={email}
            pathname={pathname}
            onNavigate={() => setOpen(false)}
            showConnectSite={showConnectSite}
            hasSites={sites.length > 0}
            onOpenPalette={() => {
              setOpen(false);
              setPaletteOpen(true);
            }}
            showMarketplace={showMarketplace}
            showUsers={showUsers}
          />
        </div>
      </dialog>

      {/* Exactly one palette for the whole shell, outside both SidebarBody
          instances. Rendered here rather than inside them because
          SidebarBody mounts twice (desktop aside + mobile sheet) and two
          open modal dialogs put the first into the inert layer. */}
      {sites.length > 0 && (
        <SitePalette sites={sites} open={paletteOpen} onOpenChange={setPaletteOpen} />
      )}
    </>
  );
}
