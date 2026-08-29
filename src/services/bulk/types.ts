export type BulkKind = "update" | "activate" | "deactivate" | "delete";
export type BulkTarget = "plugin" | "theme";

export interface BulkItem { id: string; label: string }
export interface BulkExclusion extends BulkItem { reason: string }
export interface BulkSplit { included: BulkItem[]; excluded: BulkExclusion[] }

/** Job payload — one job per target, all sharing a batch_id. */
export interface BulkJobPayload {
  kind: BulkKind;
  target: BulkTarget;
  id: string;
  /** Display name captured at enqueue time, so the batch view can name the
   *  item even if the inventory changes underneath it. */
  label: string;
}
