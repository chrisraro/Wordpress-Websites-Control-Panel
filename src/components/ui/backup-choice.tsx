"use client";

/**
 * "Update without a backup", inside a confirmation dialog that queues updates.
 *
 * The default -- unticked -- is the safe one: every site is backed up with
 * its own UpdraftPlus before the update runs. Ticking it posts `backup=skip`,
 * which the update jobs read as the operator's explicit choice to go ahead
 * unbacked (src/services/backup/gate.ts).
 *
 * Uncontrolled by default, like TimingChoice: the checkbox is part of the
 * surrounding <form>, so the choice reaches the server action's FormData
 * with no extra wiring. Pass `skip`/`onChange` where the dialog is not inside
 * a form. The whole row is the label and at least 44px tall on touch
 * devices, so it can be hit with a thumb.
 */
export function BackupChoice({
  skip, onChange,
}: {
  skip?: boolean;
  onChange?: (skip: boolean) => void;
} = {}) {
  const controlled = skip !== undefined;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-body font-medium text-ink">Backup before updating</legend>
      <p className="text-caption tracking-normal text-mid-gray">
        Sites with UpdraftPlus are backed up first, and the update waits until that backup
        finishes. A site without it will fail instead of updating, unless you choose to update
        without a backup.
      </p>
      <label
        className="flex min-h-10 cursor-pointer items-start gap-3 rounded-2xl border border-hairline px-4 py-3
          transition-colors duration-150 hover:bg-canvas has-[:checked]:border-ink pointer-coarse:min-h-11"
      >
        <input
          type="checkbox"
          name="backup"
          value="skip"
          {...(controlled
            ? { checked: skip, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.checked) }
            : {})}
          className="mt-1 size-4 shrink-0 accent-ink"
        />
        <span className="min-w-0">
          <span className="block text-body font-medium text-ink">Update without a backup</span>
          <span className="block text-caption tracking-normal text-mid-gray">
            Skips the backup on every site in this run. Only choose this if a recent backup
            exists some other way.
          </span>
        </span>
      </label>
    </fieldset>
  );
}
