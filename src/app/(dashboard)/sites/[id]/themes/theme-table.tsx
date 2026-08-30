"use client";

/**
 * Client half of the Themes tab, mirroring plugin-table.tsx: the page (Server
 * Component) loads the snapshot and renders the header; this owns row
 * selection, the bulk action bar, and per-row actions.
 *
 * Themes differ from plugins in two ways that shape this file: they are
 * switched rather than deactivated (no "deactivate" anywhere here), and a
 * theme reporting status "inactive" is not necessarily safe to delete — it
 * may be the parent of the active theme. `canDeleteTheme`'s reason strings
 * are written to be read verbatim, so a refused delete shows that reason
 * instead of the button rather than just omitting it.
 */
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, StatusBadge } from "@/components/ui/primitives";
import { tableCellClass, tableHeadClass, tableRowClass } from "@/components/ui/styles";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/modal";
import {
  BulkBar, RowCheckbox, SelectAllCheckbox, useSelection, type BulkAction,
} from "@/components/ui/selection";
import { splitEligible } from "@/services/bulk/service";
import type { BulkKind, BulkScope } from "@/services/bulk/types";
import type { ThemeInfo } from "@/services/inventory/types";
import { canActivateTheme, canDeleteTheme } from "@/services/themes/safety";
import { ManageForm } from "../action-form";
import { manageAction } from "../manage-actions";
import { bulkAction } from "../bulk-actions";

// The exact consequence, used verbatim in every delete confirmation — single
// vs. bulk, so the warning never drifts between the two paths.
const DELETE_CONSEQUENCE =
  "Deleting removes the theme's files from the server. This cannot be undone.";

/** Themes are switched, never deactivated, and bulk-activating many themes is
 *  meaningless since only one can be active — so the bar offers only these. */
type ThemeBulkKind = Extract<BulkKind, "update" | "delete">;

const KIND_LABEL: Record<ThemeBulkKind, string> = {
  update: "Update",
  delete: "Delete",
};

const BULK_KINDS: ThemeBulkKind[] = ["update", "delete"];

export function ThemeTable({
  siteId, siteName, siteEnv, themes, canManage,
}: {
  siteId: string;
  siteName: string;
  /** Rendered into every confirm title, so the environment is read before
      the click rather than inferred from a name. */
  siteEnv: string;
  themes: ThemeInfo[];
  /** Whether the viewer holds wp_toolkit.manage — read-only viewers (clients)
   *  get the table without selection, per-row actions, or the bulk bar. */
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirmKind, setConfirmKind] = useState<ThemeBulkKind | null>(null);

  const ids = useMemo(() => themes.map((t) => t.name), [themes]);
  const { selected, isSelected, toggle, toggleAll, clear, allChecked, someChecked } =
    useSelection(ids);

  const scope: BulkScope = useMemo(() => ({ target: "theme", themes }), [themes]);

  const confirmSplit = confirmKind ? splitEligible(confirmKind, scope, selected) : null;

  function runBulk(kind: ThemeBulkKind) {
    setConfirmKind(null);
    startTransition(async () => {
      const result = await bulkAction(siteId, kind, "theme", selected);
      if (result.ok && result.batchId) {
        const queued = result.queued ?? 0;
        toast({
          tone: "success",
          title: `Queued ${queued} item${queued === 1 ? "" : "s"}`,
          // "ineligible" named the check, not the reason. The dialog already
          // lists each skipped item with its own reason; this is the count.
          description: result.skipped
            ? `${result.skipped} item${result.skipped === 1 ? "" : "s"} skipped — nothing to do for ${result.skipped === 1 ? "it" : "them"}.`
            : undefined,
        });
        clear();
        router.push(`/marketplace/batches/${result.batchId}`);
      } else {
        toast({
          tone: "error",
          title: "Bulk action failed",
          description: result.error ?? "The action could not be queued.",
        });
      }
    });
  }

  const bulkActions: BulkAction[] = BULK_KINDS.map((kind) => {
    const split = splitEligible(kind, scope, selected);
    const disabled = pending || split.included.length === 0;
    return {
      key: kind,
      label: KIND_LABEL[kind],
      tone: kind === "delete" ? "danger" : "default",
      disabled,
      disabledReason:
        disabled && !pending
          ? `Nothing eligible — ${split.excluded[0]?.reason ?? "all items skipped"}`
          : undefined,
      onClick: () => setConfirmKind(kind),
    };
  });

  return (
    <>
      <Card className="overflow-hidden">
        <div className="scroll-x-hint">
          <table className="w-full min-w-[640px] text-body">
            <thead>
              <tr className={tableHeadClass}>
                {canManage && (
                  <th scope="col" className="w-10 px-2 py-3">
                    <SelectAllCheckbox allChecked={allChecked} someChecked={someChecked} onChange={toggleAll} />
                  </th>
                )}
                <th scope="col" className="px-5 py-3 font-medium">Theme</th>
                <th scope="col" className="px-5 py-3 font-medium">Version</th>
                <th scope="col" className="px-5 py-3 font-medium">Status</th>
                <th scope="col" className="px-5 py-3 font-medium">Update</th>
                {canManage && <th scope="col" className="px-5 py-3 text-right font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {themes.map((t) => {
                const name = t.title || t.name;
                const isActive = t.status === "active";
                // Only meaningful (and only computed) for inactive themes —
                // an active theme's own gate reasons ("this is active") are
                // the expected, unsurprising state and need no explanation.
                const activateVerdict = isActive ? null : canActivateTheme(themes, t.name);
                const deleteVerdict = isActive ? null : canDeleteTheme(themes, t.name);

                const update = manageAction.bind(null, siteId, {
                  kind: "update_theme" as const, slug: t.name,
                });
                const activate = manageAction.bind(null, siteId, {
                  kind: "activate_theme" as const, slug: t.name,
                });
                const deleteTheme = manageAction.bind(null, siteId, {
                  kind: "delete_theme" as const, slug: t.name,
                });

                return (
                  <tr key={t.name} className={tableRowClass}>
                    {canManage && (
                      <td className="w-10 px-2 py-3">
                        <RowCheckbox checked={isSelected(t.name)} onChange={() => toggle(t.name)} label={name} />
                      </td>
                    )}
                    <td className={`${tableCellClass} font-medium text-ink`}>{name}</td>
                    <td className={`${tableCellClass} text-mid-gray`}>{t.version}</td>
                    <td className={tableCellClass}>
                      <StatusBadge tone={isActive ? "good" : "idle"}>{t.status}</StatusBadge>
                    </td>
                    <td className={tableCellClass}>
                      {t.update === "available" ? (
                        <StatusBadge tone="warn">{t.update_version ?? "available"}</StatusBadge>
                      ) : (
                        <span className="text-caption tracking-normal text-mid-gray">current</span>
                      )}
                    </td>
                    {canManage && (
                    <td className={tableCellClass}>
                      <div className="flex flex-col items-end gap-1.5">
                        <div className="flex flex-wrap justify-end gap-2">
                          {t.update === "available" && (
                            <ManageForm
                              action={update}
                              label="Update"
                              pendingLabel="Updating…"
                              success={`${name} updated`}
                              size="sm"
                              confirm={{
                                title: `Update ${name} on ${siteName}${siteEnv}?`,
                                description: `Version ${t.version} will be replaced with ${t.update_version ?? "the latest release"} on ${siteName}. If this theme has been edited directly, those changes will be lost — that is what child themes are for.`,
                                confirmLabel: "Update",
                              }}

                            />
                          )}
                          {!isActive && activateVerdict?.allowed && (
                            <ManageForm
                              action={activate}
                              label="Activate"
                              pendingLabel="Activating…"
                              success={`${name} activated`}
                              size="sm"
                              confirm={{
                                title: `Activate ${name} on ${siteName}${siteEnv}?`,
                                description: `${siteName} will switch to ${name} immediately.`,
                                confirmLabel: "Activate",
                              }}

                            />
                          )}
                          {!isActive && deleteVerdict?.allowed && (
                            <ManageForm
                              action={deleteTheme}
                              label="Delete"
                              pendingLabel="Deleting…"
                              success={`${name} deleted`}
                              size="sm"
                              variant="danger"
                              confirm={{
                                title: `Delete ${name} on ${siteName}${siteEnv}?`,
                                description: DELETE_CONSEQUENCE,
                                confirmLabel: "Delete",
                                tone: "danger",
                              }}

                            />
                          )}
                        </div>
                        {/* The parent-theme case must read as an explanation,
                            not as a missing feature. */}
                        {deleteVerdict && !deleteVerdict.allowed && (
                          <p className="max-w-56 text-right text-caption tracking-normal text-mid-gray">
                            {deleteVerdict.reason}
                          </p>
                        )}
                      </div>
                    </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {canManage && <BulkBar count={selected.length} actions={bulkActions} onClear={clear} />}

      <ConfirmDialog
        open={confirmKind !== null}
        title={
          confirmKind
            ? `${KIND_LABEL[confirmKind]} ${confirmSplit?.included.length ?? 0} theme${
                (confirmSplit?.included.length ?? 0) === 1 ? "" : "s"
              } on ${siteName}${siteEnv}?`
            : ""
        }
        tone={confirmKind === "delete" ? "danger" : "default"}
        confirmLabel={confirmKind ? KIND_LABEL[confirmKind] : "Confirm"}
        onCancel={() => setConfirmKind(null)}
        onConfirm={() => confirmKind && runBulk(confirmKind)}
        description={
          confirmSplit && (
            <div className="space-y-2">
              {confirmKind === "delete" && <p>{DELETE_CONSEQUENCE}</p>}
              <p>
                {confirmSplit.included.length} theme{confirmSplit.included.length === 1 ? "" : "s"} on{" "}
                {siteName}{siteEnv} will be queued:{" "}
                {confirmSplit.included.map((i) => i.label).join(", ")}.
              </p>
              {confirmSplit.excluded.length > 0 && (
                <p className="text-caption tracking-normal text-mid-gray">
                  {confirmSplit.excluded.length} item{confirmSplit.excluded.length === 1 ? "" : "s"} will be
                  skipped —{" "}
                  {confirmSplit.excluded.map((e) => `${e.label} (${e.reason})`).join("; ")}.
                </p>
              )}
            </div>
          )
        }
      />
    </>
  );
}
