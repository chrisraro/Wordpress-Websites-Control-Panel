import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-white px-4 py-3 sm:px-6">
        <nav className="flex items-center gap-4 sm:gap-6">
          <Link href="/dashboard" className="font-semibold">WP Control Panel</Link>
          <Link href="/sites/new" className="py-2 text-sm text-slate-600 hover:text-slate-900">
            + Connect site
          </Link>
        </nav>
        <form action={logout} className="flex items-center gap-3 text-sm text-slate-600">
          <span className="hidden sm:inline">{user.email}</span>
          <button className="min-h-10 rounded border px-3 py-2 hover:bg-slate-100">Sign out</button>
        </form>
      </header>
      {children}
    </div>
  );
}
