"use client";

/**
 * Site grants for one account: the current list with remove, and (for a
 * client, or an account with no role yet) an add control.
 *
 * Site grants are only meaningful for a `client` -- a developer, content
 * writer or admin already reaches every site through `sites.view_all`, so a
 * grant on one of those roles adds nothing (see docs/superpowers/specs/
 * 2026-08-29-phase9b-user-management-design.md §2.2). For those roles this
 * renders a note instead of an add control that would do nothing, but still
 * *lists* any existing grants -- a leftover row from an earlier role would
 * otherwise be invisible and never get cleaned up.
 *
 * A `manage`-level grant on a client is the one thing here with real
 * teeth: per docs/superpowers/specs/2026-08-29-phase9a-authorization-
 * design.md (refreshInventoryAction requires site access at manage, not
 * read, specifically to exclude read-only clients), manage-level access
 * lets a client trigger `refreshInventoryAction`, which opens an MCP
 * connection and runs PHP on their live WordPress site. `read` is the right
 * default for a client, and the difference is called out at the point of
 * choosing, not just after the fact.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { grantSiteAction, revokeSiteAction } from "../actions";
import { StatusBadge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { buttonClass, hintClass, inputClass, labelClass } from "@/components/ui/styles";
import { IconAlert, IconInfo, IconSpinner } from "@/components/ui/icons";
import type { AppRole, SiteAccessLevel } from "@/lib/authz/types";

const ROLE_LABEL: Record<AppRole, string> = {
  admin: "Admin",
  developer: "Developer",
  content_writer: "Content writer",
  client: "Client",
};

export interface SiteGrantRow {
  siteId: string;
  siteName: string;
  accessLevel: SiteAccessLevel;
}

export function SiteGrants({
  userId, role, grants, availableSites,
}: {
  userId: string;
  role: AppRole | null;
  grants: SiteGrantRow[];
  availableSites: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [addSiteId, setAddSiteId] = useState("");
  const [addLevel, setAddLevel] = useState<SiteAccessLevel>("read");
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"add" | string | null>(null);

  // Staff (any role that isn't a client) already sees every site via
  // sites.view_all, so grants add nothing for them -- a null role has no
  // permissions at all yet and may still become a client, so it gets the
  // add control too rather than the "this does nothing" note. Narrowed to a
  // variable (rather than a bare boolean) so ROLE_LABEL[staffRole] below
  // type-checks without a redundant null check.
  const staffRole = role !== null && role !== "client" ? role : null;
  const isStaffRole = staffRole !== null;

  function handleAdd() {
    if (!addSiteId) return;
    setBusy("add");
    startTransition(async () => {
      const result = await grantSiteAction(userId, addSiteId, addLevel);
      setBusy(null);
      if (result.ok) {
        toast({ tone: "success", title: "Site granted" });
        setAddSiteId("");
        setAddLevel("read");
        router.refresh();
      } else {
        toast({ tone: "error", title: "Could not grant access", description: result.error });
      }
    });
  }

  function handleRemove(siteId: string) {
    setBusy(siteId);
    startTransition(async () => {
      const result = await revokeSiteAction(userId, siteId);
      setBusy(null);
      if (result.ok) {
        toast({ tone: "success", title: "Site access removed" });
        router.refresh();
      } else {
        toast({ tone: "error", title: "Could not remove access", description: result.error });
      }
    });
  }

  return (
    <div className="space-y-4">
      {staffRole && (
        <p className={`flex items-start gap-2 ${hintClass}`}>
          <IconInfo size={16} className="mt-0.5 shrink-0" />
          Grants aren&apos;t necessary for a {ROLE_LABEL[staffRole]} — this role already reaches
          every site through the &quot;view all sites&quot; permission. Any grants below are
          still listed and removable in case they&apos;re left over from an earlier role.
        </p>
      )}

      {grants.length === 0 ? (
        <p className={hintClass}>
          No sites granted
          {role === "client" ? " — this client's dashboard is empty until you add one." : "."}
        </p>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-3xl border border-hairline">
          {grants.map((g) => {
            // A null role is mid-setup and just as consequential as a client
            // once a manage grant is in place -- see the file header and
            // Finding 1 of docs/superpowers/sdd/task-5-report.md.
            const isConsequential = !isStaffRole && g.accessLevel === "manage";
            const removing = pending && busy === g.siteId;
            return (
              <li
                key={g.siteId}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-body font-medium text-ink">{g.siteName}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <StatusBadge tone={g.accessLevel === "manage" ? "warn" : "idle"}>
                      {g.accessLevel === "manage" ? "Manage" : "Read"}
                    </StatusBadge>
                    {isConsequential && (
                      <span className="text-caption tracking-normal text-mid-gray">
                        Can trigger live inventory refreshes on this site
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(g.siteId)}
                  disabled={removing}
                  aria-label={`Remove access to ${g.siteName}`}
                  className={buttonClass("danger", "sm")}
                >
                  {removing && <IconSpinner size={14} />}
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!isStaffRole && (
        <fieldset className="space-y-2 rounded-3xl border border-hairline p-3">
          <legend className={labelClass}>Add a site</legend>
          {availableSites.length === 0 ? (
            <p className={hintClass}>
              Every connected site is already granted, or none are connected yet.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  aria-label="Site"
                  value={addSiteId}
                  onChange={(e) => setAddSiteId(e.target.value)}
                  className={inputClass}
                >
                  <option value="" disabled>
                    Select a site
                  </option>
                  {availableSites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Access level"
                  value={addLevel}
                  onChange={(e) => setAddLevel(e.target.value as SiteAccessLevel)}
                  className={inputClass}
                >
                  <option value="read">Read</option>
                  <option value="manage">Manage</option>
                </select>
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={!addSiteId || (pending && busy === "add")}
                  className={buttonClass("primary")}
                >
                  {pending && busy === "add" && <IconSpinner size={16} />}
                  Grant
                </button>
              </div>
              {addLevel === "manage" && (
                // This block only renders when !isStaffRole (client or null
                // role) -- see Finding 1 of docs/superpowers/sdd/
                // task-5-report.md. A not-yet-roled account is exactly the
                // state where an admin is most likely to be handing out
                // access, so it must see this warning too.
                <p className="flex items-start gap-2 text-caption tracking-normal text-ember">
                  <IconAlert size={14} className="mt-0.5 shrink-0" />
                  Manage-level access lets this client trigger inventory refreshes, which opens a
                  live connection to the site&apos;s WordPress install and runs PHP there. Read is
                  the right default for a client — only choose Manage if they specifically need
                  to refresh inventory themselves.
                </p>
              )}
            </>
          )}
        </fieldset>
      )}
    </div>
  );
}
