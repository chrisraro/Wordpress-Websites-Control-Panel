import type { ReactNode } from "react";
import { requireUser } from "@/lib/supabase/server";
import { Sidebar } from "@/components/shell/sidebar";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="min-h-screen lg:pl-60">
      <Sidebar email={user.email ?? "Signed in"} />
      {/* Page max-width per DESIGN.md, measured inside the sidebar column. */}
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 sm:py-8">{children}</div>
    </div>
  );
}
