import type { ReactNode } from "react";
import { requireViewer } from "@/lib/authz/server";
import { can } from "@/lib/authz/decide";
import { Sidebar } from "@/components/shell/sidebar";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // requireViewer() only confirms someone is signed in with a valid role —
  // it is authentication, not per-page authorization. It says nothing about
  // which sites this user may reach, and a layout runs once per navigation,
  // not once per request a page could otherwise receive directly. Every page
  // under this layout calls its own requireViewer()/requirePermission()/
  // requireSiteAccess() rather than relying on this check. It is used here
  // (via cache()) only to decide which nav affordances to show — Sidebar is a
  // Client Component and must not receive the Viewer itself, since its
  // Set/Map fields do not cross the RSC boundary, so only plain booleans are
  // passed down.
  const viewer = await requireViewer();
  return (
    <div className="min-h-screen lg:pl-60">
      <Sidebar
        email={viewer.email ?? "Signed in"}
        showConnectSite={can(viewer, "sites.manage")}
        showMarketplace={can(viewer, "wp_toolkit.manage")}
      />
      {/* Page max-width per DESIGN.md, measured inside the sidebar column. */}
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 sm:py-8">{children}</div>
    </div>
  );
}
