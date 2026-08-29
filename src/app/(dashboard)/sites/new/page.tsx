import { requirePermission } from "@/lib/authz/server";
import { NewSiteForm } from "./new-site-form";

export default async function NewSitePage() {
  await requirePermission("sites.manage");
  return <NewSiteForm />;
}
