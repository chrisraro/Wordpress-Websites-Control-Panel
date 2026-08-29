import { requirePermission } from "@/lib/authz/server";
import { ConnectSiteModal } from "./connect-site-modal";

/**
 * The intercepted, modal presentation of /sites/new. This is a real route
 * with its own entry point (Next.js falls back to it whenever the plain
 * /sites/new page.tsx isn't reached client-side from within (dashboard)),
 * so it must not assume the plain page's requirePermission call covers it --
 * it needs its own.
 */
export default async function InterceptedNewSitePage() {
  await requirePermission("sites.manage");
  return <ConnectSiteModal />;
}
