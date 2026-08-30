"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createInstallBatchAction } from "./actions";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { buttonClass } from "@/components/ui/styles";
import { IconAlert, IconSpinner } from "@/components/ui/icons";

export interface SiteOption { id: string; name: string }

export function InstallPanel({
  slug, name, sites, target = "plugin",
}: { slug: string; name: string; sites: SiteOption[]; target?: "plugin" | "theme" }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Plugins: default on — activating one plugin on a site is low-stakes.
  // Themes: default OFF — checking this on N selected sites switches every
  // one of those sites' live front-end appearance, with nothing else in this
  // modal warning about it otherwise. Compare the per-row theme "Activate"
  // action and "Create and activate" child theme, which both carry a confirm
  // dialog naming the consequence before it happens.
  const [activate, setActivate] = useState(target !== "theme");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await createInstallBatchAction({
        source: { kind: "wporg", slug }, siteIds: [...selected], activate, target,
      });
      if (res.ok && res.batchId) {
        toast({
          tone: "success",
          title: `Installing ${name}`,
          description: `Queued on ${selected.size} site${selected.size === 1 ? "" : "s"}.`,
        });
        router.push(`/marketplace/batches/${res.batchId}`);
      } else {
        setError(res.error ?? "Failed to start the install");
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={sites.length === 0}
        className={buttonClass("primary", "md", "mt-3 w-full")}
      >
        {sites.length === 0 ? "No sites connected" : "Install…"}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Install ${name}`}
        description="Choose the sites to install it on. Each site runs as its own job, so one failure does not block the rest."
        footer={
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={buttonClass("secondary")}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || selected.size === 0}
              className={buttonClass("primary")}
            >
              {pending && <IconSpinner size={16} />}
              {pending
                ? "Starting…"
                : selected.size === 0
                  ? "Select a site"
                  : `Install on ${selected.size} site${selected.size === 1 ? "" : "s"}`}
            </button>
          </>
        }
      >
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {sites.map((s) => (
            <label
              key={s.id}
              className="flex min-h-10 pointer-coarse:min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-3
                transition-colors duration-150 hover:bg-canvas"
            >
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
                className="size-4 shrink-0 rounded-md accent-ink"
              />
              <span className="min-w-0 flex-1 truncate text-body text-ink">{s.name}</span>
            </label>
          ))}
        </div>

        <label
          className="mt-2 flex min-h-10 pointer-coarse:min-h-11 cursor-pointer items-center gap-3 rounded-2xl border-t
            border-hairline px-3 pt-3"
        >
          <input
            type="checkbox"
            checked={activate}
            onChange={(e) => setActivate(e.target.checked)}
            className="size-4 shrink-0 rounded-md accent-ink"
          />
          <span className="text-body text-ink">Activate after install</span>
        </label>

        {target === "theme" && activate && (
          <p className="mt-2 flex items-start gap-2 text-body text-ember">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            This switches the live theme immediately on every site selected above.
          </p>
        )}

        {error && (
          <p aria-live="polite" className="mt-3 flex items-start gap-2 text-body text-ember">
            <IconAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
