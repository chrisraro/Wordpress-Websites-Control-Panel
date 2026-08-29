import { requirePermission } from "@/lib/authz/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseUsersRepo } from "@/services/users/repo";
import { listRolePermissions } from "@/services/users/service";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { PageHeader } from "@/components/ui/primitives";
import { PermissionMatrix } from "./matrix";

// Reads through the service-role client, matching every other page in this
// module -- role_permissions is broadly readable to any authenticated user
// (see supabase/migrations/0008_rls_scoped.sql), but the app never depends
// on that policy: this page is gated on users.manage below regardless.
export const dynamic = "force-dynamic";

export default async function RolesPage() {
  // Gated exactly like /users and /users/[id]: users.manage or a 404.
  await requirePermission("users.manage");

  const db = createServiceSupabase();
  const usersRepo = supabaseUsersRepo(db);
  const rolePermissions = await listRolePermissions(usersRepo);

  return (
    <main>
      <Breadcrumbs items={[{ label: "Users", href: "/users" }, { label: "Permission matrix" }]} />

      <PageHeader
        title="Permission matrix"
        subtitle="What each role may do. Ten permissions, four roles."
      />

      <PermissionMatrix rolePermissions={rolePermissions} />
    </main>
  );
}
