import type { ReactNode } from "react";
import { requireViewer } from "@/lib/authz/server";
import { can } from "@/lib/authz/decide";
import { Sidebar } from "@/components/shell/sidebar";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { readDbFor } from "@/lib/authz/db";
import { isStagingSite } from "@/services/sites/portfolio";

export default async function DashboardLayout({
  children,
  modal,
}: {
  children: ReactNode;
  modal: ReactNode;
}) {
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

  // listSites() is already scoped to what this viewer may see, so a client
  // gets a palette over their own sites and nothing else. Only the four
  // fields the palette needs cross the RSC boundary -- Sidebar is a Client
  // Component and must not receive site rows wholesale.
  const db = await readDbFor(viewer);
  const sites = (
    await listSites({
      repo: supabaseSitesRepo(db),
      mcp: createSiteMcpClient,
      jobs: supabaseJobsRepo(db),
    })
  ).map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    client_label: s.client_label,
    staging: isStagingSite(s),
  }));

  return (
    <div className="min-h-screen lg:pl-60">
      {/* The <aside> precedes the page in DOM order, so Tab from the address
          bar walked seven sidebar stops -- logo, Connect site, Sites,
          Marketplace, Users, the email, Sign out -- before reaching any page
          content, on every single navigation. Visible only on focus, which is
          the point: it costs sighted mouse users nothing and saves keyboard
          users seven presses per page. */}
      <a
        href="#main"
        className="sr-only rounded-2xl bg-ink px-4 py-2 text-body font-medium text-paper
          focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to content
      </a>
      <Sidebar
        email={viewer.email ?? "Signed in"}
        showConnectSite={can(viewer, "sites.manage")}
        showMarketplace={can(viewer, "wp_toolkit.manage")}
        showUsers={can(viewer, "users.manage")}
        sites={sites}
      />
      {/* Page max-width per DESIGN.md, measured inside the sidebar column. */}
      <div id="main" className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </div>
      {modal}
    </div>
  );
}
