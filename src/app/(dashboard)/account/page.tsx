import { requireViewer } from "@/lib/authz/server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { supabaseTokensRepo } from "@/services/tokens/repo";
import { listTokensOrUnavailable } from "@/services/tokens/service";
import { Card, CardTitle, PageHeader } from "@/components/ui/primitives";
import { ApiTokensCard } from "@/app/(dashboard)/users/[id]/api-tokens-card";

// Same reasoning as /users/[id]: reads through the service-role client so
// this page never depends on RLS granting a signed-in user read access to
// their own api_tokens rows -- gated in application code below instead.
export const dynamic = "force-dynamic";

/**
 * Self-service surface for API tokens, reachable by any signed-in user with
 * a role -- unlike /users/[id], which is gated on users.manage and 404s for
 * everyone else. A developer, content writer or client minting a token for
 * their own Claude Code has no other page that would ever let them in the
 * door. See docs/superpowers/sdd/task-12-report.md for why this page exists
 * alongside the spec's original /users/[id]-only design.
 *
 * requireViewer() (not requirePermission) is deliberate: holding a role at
 * all is the only bar here, matching every other role's ability to reach
 * this, their own account.
 */
export default async function AccountPage() {
  const viewer = await requireViewer();

  const db = createServiceSupabase();
  // Same deploy-order guard as /users/[id]: if migration 0021 (api_tokens)
  // has not been applied yet, render the hint rather than a 500.
  const tokenList = await listTokensOrUnavailable(supabaseTokensRepo(db), viewer.id);

  return (
    <main>
      <PageHeader
        title="Your account"
        subtitle={viewer.email ? `Signed in as ${viewer.email}` : undefined}
      />

      <Card className="overflow-hidden">
        <CardTitle>API tokens</CardTitle>
        <div className="p-5">
          <ApiTokensCard
            mode="self"
            userId={viewer.id}
            tokens={tokenList.tokens}
            tokensUnavailable={tokenList.unavailable}
          />
        </div>
      </Card>
    </main>
  );
}
