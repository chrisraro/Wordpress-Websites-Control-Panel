import Link from "next/link";
import { requirePermission } from "@/lib/authz/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseUsersRepo } from "@/services/users/repo";
import { listManagedUsers } from "@/services/users/service";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { supabaseJobsRepo } from "@/services/jobs/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { buttonClass, tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { IconChevronRight, IconShield, IconUsers } from "@/components/ui/icons";
import { InviteDialog } from "./invite-dialog";
import type { AppRole } from "@/lib/authz/types";

// Reads through auth.admin.listUsers() (last_sign_in_at, invite status),
// which only exists on the service-role client — never reachable from a
// user's own session regardless of what this page renders.
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<AppRole, string> = {
  admin: "Admin",
  developer: "Developer",
  content_writer: "Content writer",
  client: "Client",
};

export default async function UsersPage() {
  // First line, per the Phase 9b design: this whole surface is gated on
  // users.manage and 404s for anyone else, matching every other staff-only
  // page in this app.
  await requirePermission("users.manage");

  const db = createServiceSupabase();
  const usersRepo = supabaseUsersRepo(db);
  const sitesDeps = { repo: supabaseSitesRepo(db), mcp: createSiteMcpClient, jobs: supabaseJobsRepo(db) };

  const [users, allSites] = await Promise.all([
    listManagedUsers(usersRepo),
    listSites(sitesDeps),
  ]);
  // A disabled site is not somewhere to grant a new client — offering it in
  // the invite dialog would create a grant to a connection nobody trusts.
  const inviteSites = allSites
    .filter((s) => s.status !== "disabled")
    .map((s) => ({ id: s.id, name: s.name }));

  return (
    <main>
      <PageHeader
        title="Users"
        subtitle="Invite people, and see who can sign in to the panel."
        actions={
          <>
            <Link href="/users/roles" className={buttonClass("outline")}>
              <IconShield size={16} className="shrink-0" />
              Permission matrix
            </Link>
            <InviteDialog sites={inviteSites} />
          </>
        }
      />

      {users.length === 0 ? (
        <Card className="overflow-hidden">
          <EmptyState icon={<IconUsers size={28} />} title="No accounts yet">
            Invite the first person to get started.
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="scroll-x-hint">
            <table className="w-full min-w-[640px] text-body">
              <thead>
                <tr className={tableHeadClass}>
                  <th scope="col" className="px-5 py-3 font-medium">Email</th>
                  <th scope="col" className="px-5 py-3 font-medium">Role</th>
                  <th scope="col" className="px-5 py-3 font-medium">Sites</th>
                  <th scope="col" className="px-5 py-3 font-medium">Last sign-in</th>
                  <th scope="col" className="px-5 py-3 font-medium">Status</th>
                  <th scope="col" className="px-5 py-3">
                    <span className="sr-only">Manage</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={tableRowClass}>
                    <td className={`${tableCellClass} font-medium text-ink`}>
                      {u.email ?? "—"}
                    </td>
                    <td className={tableCellClass}>
                      {u.role ? (
                        <StatusBadge tone="idle">{ROLE_LABEL[u.role]}</StatusBadge>
                      ) : (
                        // A real, reachable state: the account exists and can
                        // sign in, but getViewer() denies it everything. It
                        // must never render as a blank cell. See Finding 4 of
                        // docs/superpowers/sdd/task-5-report.md.
                        <StatusBadge tone="bad">No role — sees nothing</StatusBadge>
                      )}
                    </td>
                    <td className={`${tableCellClass} text-mid-gray`} data-tabular>
                      {u.siteGrants}
                    </td>
                    <td className={`${tableCellClass} text-mid-gray`}>
                      {u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleString() : "Never"}
                    </td>
                    <td className={tableCellClass}>
                      {u.invitedNotAccepted ? (
                        <StatusBadge tone="info">Invited</StatusBadge>
                      ) : (
                        <StatusBadge tone="good">Active</StatusBadge>
                      )}
                    </td>
                    <td className={`${tableCellClass} text-right`}>
                      <Link
                        href={`/users/${u.id}`}
                        className="inline-flex items-center gap-1 text-body text-ink underline-offset-2
                          transition-colors duration-150 hover:underline"
                      >
                        Manage
                        <IconChevronRight size={14} className="shrink-0" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </main>
  );
}
