import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/authz/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseUsersRepo } from "@/services/users/repo";
import { listSiteGrants } from "@/services/users/service";
import { canChangeRole, canDeleteUser } from "@/services/users/guards";
import { listSites } from "@/services/sites/service";
import { supabaseSitesRepo } from "@/services/sites/repo";
import { createSiteMcpClient } from "@/lib/mcp/client";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { Card, CardTitle, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { RoleForm } from "./role-form";
import { SiteGrants } from "./site-grants";
import { DeleteAccountForm } from "./delete-account";
import type { AppRole } from "@/lib/authz/types";

// Same reasoning as /users: last_sign_in_at and the auth-admin lookups only
// exist on the service-role client, so this reads through it regardless of
// what the page renders, and is gated in application code below.
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<AppRole, string> = {
  admin: "Admin",
  developer: "Developer",
  content_writer: "Content writer",
  client: "Client",
};

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Gated exactly like /users: users.manage or a 404, matching every other
  // staff-only page in this app.
  const viewer = await requirePermission("users.manage");

  const db = createServiceSupabase();
  const usersRepo = supabaseUsersRepo(db);
  const sitesDeps = { repo: supabaseSitesRepo(db), mcp: createSiteMcpClient };

  const [person, users, grants, allSites] = await Promise.all([
    usersRepo.getUser(id),
    usersRepo.listUsers(),
    listSiteGrants(usersRepo, id),
    listSites(sitesDeps),
  ]);
  if (!person) notFound();

  // The lockout guards are pure functions over the user list, evaluated here
  // on the server, then crossed to the client as a plain { allowed, reason }
  // verdict -- never the guard functions or the user list itself.
  //
  // canChangeRole's refusal never depends on which role is picked next: once
  // `next` differs from the account's current role, whether the account is
  // the sole admin is the only thing that decides (see guards.ts). So any
  // role other than the current one is a valid probe for "would changing
  // this account away from its current role be refused right now" -- which
  // is exactly what the control needs to know before the admin has picked
  // anything. The write itself re-checks against a freshly read list at the
  // moment it runs; this is only what the control displays.
  const probeRole: AppRole = person.role === "admin" ? "developer" : "admin";
  const roleVerdict = canChangeRole(users, id, probeRole);
  const deleteVerdict = canDeleteUser(users, viewer.id, id);

  const siteNameById = new Map(allSites.map((s) => [s.id, s.name] as const));
  const grantedSiteIds = new Set(grants.map((g) => g.siteId));
  const grantRows = grants
    .map((g) => ({
      siteId: g.siteId,
      // A grant can outlive the site it points at only in theory (grants
      // cascade-delete with the site), but never silently drop a row here.
      siteName: siteNameById.get(g.siteId) ?? "Unknown site",
      accessLevel: g.accessLevel,
    }))
    .sort((a, b) => a.siteName.localeCompare(b.siteName));

  // A disabled site is not somewhere to grant access to -- same reasoning as
  // the invite dialog's site list.
  const availableSites = allSites
    .filter((s) => s.status !== "disabled" && !grantedSiteIds.has(s.id))
    .map((s) => ({ id: s.id, name: s.name }));

  return (
    <main>
      <Breadcrumbs items={[{ label: "Users", href: "/users" }, { label: person.email ?? id }]} />

      <PageHeader
        title={person.email ?? "Unknown email"}
        subtitle={
          person.role ? (
            <StatusBadge tone="idle">{ROLE_LABEL[person.role]}</StatusBadge>
          ) : (
            // Real, reachable state: this account can sign in and getViewer
            // denies it everything. Never render as a blank subtitle.
            <StatusBadge tone="bad">No role — cannot sign in</StatusBadge>
          )
        }
      />

      <div className="space-y-6">
        <Card className="overflow-hidden">
          <CardTitle>Role</CardTitle>
          <div className="p-5">
            <RoleForm
              targetId={id}
              currentRole={person.role}
              isSelf={id === viewer.id}
              verdict={roleVerdict}
            />
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardTitle>Site access</CardTitle>
          <div className="p-5">
            <SiteGrants
              userId={id}
              role={person.role}
              grants={grantRows}
              availableSites={availableSites}
            />
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardTitle>Delete account</CardTitle>
          <div className="p-5">
            <p className="mb-3 text-body text-mid-gray">
              Permanently removes this account&apos;s ability to sign in, along with its role and
              site grants. This cannot be undone.
            </p>
            <DeleteAccountForm userId={id} email={person.email} verdict={deleteVerdict} />
          </div>
        </Card>
      </div>
    </main>
  );
}
