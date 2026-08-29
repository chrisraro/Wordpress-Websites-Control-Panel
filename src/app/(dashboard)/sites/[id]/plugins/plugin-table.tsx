"use client";

/**
 * Client half of the Plugins tab. The page (Server Component) still loads the
 * snapshot and renders the header; this owns row selection, the bulk action
 * bar, and per-row actions, because selection is inherently client state.
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
import type { BulkKind } from "@/services/bulk/types";
import type { InventoryPayload, PluginInfo } from "@/services/inventory/types";
import { ManageForm } from "../action-form";
import { manageAction } from "../manage-actions";
import { bulkAction } from "../bulk-actions";

// The exact consequence, used verbatim in every delete confirmation — single
// vs. bulk, so the warning never drifts between the two paths.
const DELETE_CONSEQUENCE =
  "Deleting runs each plugin's uninstall routine, which usually removes its database tables and settings. This cannot be undone.";

const KIND_LABEL: Record<BulkKind, string> = {
  update: "Update",
  activate: "Activate",
  deactivate: "Deactivate",
  delete: "Delete",
};

const BULK_KINDS: BulkKind[] = ["update", "activate", "deactivate", "delete"];

export function PluginTable({
  siteId, siteName, plugins,
}: {
  siteId: string;
  siteName: string;
  plugins: PluginInfo[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirmKind, setConfirmKind] = useState<BulkKind | null>(null);

  const ids = useMemo(() => plugins.map((p) => p.file), [plugins]);
  const { selected, isSelected, toggle, toggleAll, clear, allChecked, someChecked } =
    useSelection(ids);

  // splitEligible is typed against the full InventoryPayload, but for a
  // "plugin" target it only ever reads `.plugins`. Filling the rest with
  // inert placeholders (rather than casting) keeps this a real, type-checked
  // value — the table only ever has the plugin list, not a whole snapshot.
  const inv: InventoryPayload = useMemo(
    () => ({
      collected_at: "",
      wp_version: "",
      php_version: "",
      admin_url: "",
      core_update: null,
      plugins,
      themes: [],
      admin_users: [],
    }),
    [plugins],
  );

  const confirmSplit = confirmKind ? splitEligible(confirmKind, "plugin", inv, selected) : null;

  function runBulk(kind: BulkKind) {
    setConfirmKind(null);
    startTransition(async () => {
      const result = await bulkAction(siteId, kind, "plugin", selected);
      if (result.ok && result.batchId) {
        const queued = result.queued ?? 0;
        toast({
          tone: "success",
          title: `Queued ${queued} item${queued === 1 ? "" : "s"}`,
          description: result.skipped ? `${result.skipped} item(s) skipped as ineligible.` : undefined,
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
    const split = splitEligible(kind, "plugin", inv, selected);
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-body">
            <thead>
              <tr className={tableHeadClass}>
                <th className="w-10 px-2 py-3">
                  <SelectAllCheckbox allChecked={allChecked} someChecked={someChecked} onChange={toggleAll} />
                </th>
                <th className="px-5 py-3 font-medium">Plugin</th>
                <th className="px-5 py-3 font-medium">Version</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Update</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((p) => {
                const activate = manageAction.bind(null, siteId, {
                  kind: "activate_plugin" as const, file: p.file,
                });
                const deactivate = manageAction.bind(null, siteId, {
                  kind: "deactivate_plugin" as const, file: p.file,
                });
                const update = manageAction.bind(null, siteId, {
                  kind: "update_plugin" as const, file: p.file,
                });
                const deletePlugin = manageAction.bind(null, siteId, {
                  kind: "delete_plugin" as const, file: p.file,
                });
                const name = p.title || p.name;
                return (
                  <tr key={p.file} className={tableRowClass}>
                    <td className="w-10 px-2 py-3">
                      <RowCheckbox checked={isSelected(p.file)} onChange={() => toggle(p.file)} label={name} />
                    </td>
                    <td className={`${tableCellClass} font-medium text-ink`}>{name}</td>
                    <td className={`${tableCellClass} text-mid-gray`}>{p.version}</td>
                    <td className={tableCellClass}>
                      <StatusBadge tone={p.status === "active" ? "good" : "idle"}>
                        {p.status}
                      </StatusBadge>
                    </td>
                    <td className={tableCellClass}>
                      {p.update === "available" ? (
                        <StatusBadge tone="warn">{p.update_version ?? "available"}</StatusBadge>
                      ) : (
                        <span className="text-caption tracking-normal text-mid-gray">current</span>
                      )}
                    </td>
                    <td className={tableCellClass}>
                      <div className="flex flex-wrap justify-end gap-2">
                        {p.update === "available" && (
                          <ManageForm
                            action={update}
                            label="Update"
                            pendingLabel="Updating…"
                            success={`${name} updated`}
                            size="sm"
                            confirm={{
                              title: `Update ${name}?`,
                              description: `Version ${p.version} will be replaced with ${p.update_version ?? "the latest release"} on ${siteName}.`,
                              confirmLabel: "Update",
                            }}
                            showInlineError={false}
                          />
                        )}
                        {p.status === "active" ? (
                          <ManageForm
                            action={deactivate}
                            label="Deactivate"
                            pendingLabel="Deactivating…"
                            success={`${name} deactivated`}
                            size="sm"
                            variant="danger"
                            confirm={{
                              title: `Deactivate ${name}?`,
                              description: `Any functionality this plugin provides will stop working on ${siteName} immediately. You can reactivate it from this page.`,
                              confirmLabel: "Deactivate",
                              tone: "danger",
                            }}
                            showInlineError={false}
                          />
                        ) : (
                          <>
                            <ManageForm
                              action={activate}
                              label="Activate"
                              pendingLabel="Activating…"
                              success={`${name} activated`}
                              size="sm"
                              confirm={{
                                title: `Activate ${name}?`,
                                description: `The plugin will start running on ${siteName} straight away.`,
                                confirmLabel: "Activate",
                              }}
                              showInlineError={false}
                            />
                            <ManageForm
                              action={deletePlugin}
                              label="Delete"
                              pendingLabel="Deleting…"
                              success={`${name} deleted`}
                              size="sm"
                              variant="danger"
                              confirm={{
                                title: `Delete ${name}?`,
                                description: DELETE_CONSEQUENCE,
                                confirmLabel: "Delete",
                                tone: "danger",
                              }}
                              showInlineError={false}
                            />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <BulkBar count={selected.length} actions={bulkActions} onClear={clear} />

      <ConfirmDialog
        open={confirmKind !== null}
        title={confirmKind ? `${KIND_LABEL[confirmKind]} ${confirmSplit?.included.length ?? 0} plugin(s)?` : ""}
        tone={confirmKind === "delete" ? "danger" : "default"}
        confirmLabel={confirmKind ? KIND_LABEL[confirmKind] : "Confirm"}
        onCancel={() => setConfirmKind(null)}
        onConfirm={() => confirmKind && runBulk(confirmKind)}
        description={
          confirmSplit && (
            <div className="space-y-2">
              {confirmKind === "delete" && <p>{DELETE_CONSEQUENCE}</p>}
              <p>
                {confirmSplit.included.length} plugin(s) on {siteName} will be queued:{" "}
                {confirmSplit.included.map((i) => i.label).join(", ")}.
              </p>
              {confirmSplit.excluded.length > 0 && (
                <p className="text-caption tracking-normal text-mid-gray">
                  {confirmSplit.excluded.length} item(s) will be skipped —{" "}
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
