import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/supabase/server";
import { logout } from "@/app/login/actions";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div>
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <nav className="flex items-center gap-6">
          <Link href="/dashboard" className="font-semibold">WP Control Panel</Link>
          <Link href="/sites/new" className="text-sm text-slate-600 hover:text-slate-900">
            + Connect site
          </Link>
        </nav>
        <form action={logout} className="flex items-center gap-3 text-sm text-slate-600">
          <span>{user.email}</span>
          <button className="rounded border px-2 py-1 hover:bg-slate-100">Sign out</button>
        </form>
      </header>
      {children}
    </div>
  );
}
