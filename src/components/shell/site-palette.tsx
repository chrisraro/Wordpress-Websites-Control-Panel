"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { badgeClass, inputClass } from "@/components/ui/styles";
import { IconSearch } from "@/components/ui/icons";

export interface PaletteSite {
  id: string;
  name: string;
  url: string;
  client_label: string | null;
  staging: boolean;
}

/**
 * ⌘K / Ctrl-K palette over the connected sites.
 *
 * DESIGN.md specifies a Search Trigger component with a ⌘K indicator; it was
 * tokenized and documented but never built, so the only way to reach a site
 * was to scroll the dashboard. PRODUCT.md's first job is a portfolio sweep
 * and its third is doing maintenance — both start with "get me to that site",
 * and at twelve sites that is already the dominant cost of a session.
 *
 * Matches on name, host and client label together, because the three carry
 * different halves of the identity: a staging copy often shares its parent's
 * name and is distinguishable only by host.
 */
export function SitePalette({ sites }: { sites: PaletteSite[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // The Modal mounts its content in the same commit, so focus has to wait
      // a frame for the input to exist.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sites.slice(0, 8);
    return sites
      .filter((s) =>
        `${s.name} ${s.url} ${s.client_label ?? ""}`.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [query, sites]);

  const go = (site: PaletteSite | undefined) => {
    if (!site) return;
    setOpen(false);
    router.push(`/sites/${site.id}`);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-4 flex min-h-10 w-full items-center gap-2 rounded-2xl bg-canvas px-3
          text-body text-mid-gray transition-colors duration-150 hover:text-ink
          focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
          pointer-coarse:min-h-11"
      >
        <IconSearch size={16} className="shrink-0" />
        <span className="flex-1 text-left">Find a site</span>
        {/* Hidden from assistive tech: the shortcut is a mouse-user hint, and
            read aloud it is noise appended to the button's name. */}
        <span aria-hidden className="text-caption tracking-normal">
          ⌘K
        </span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Find a site"
        description="Search by name, address or client."
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(matches[active]);
            }
          }}
          className={inputClass}
          placeholder="Site name or address"
          aria-label="Search sites"
        />

        <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
          {matches.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => go(s)}
                onMouseEnter={() => setActive(i)}
                className={`flex min-h-10 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left
                  transition-colors duration-150 pointer-coarse:min-h-11 ${
                    i === active ? "bg-canvas" : "hover:bg-canvas"
                  }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-body text-ink">{s.name}</span>
                    {s.staging && (
                      <span className={badgeClass("solid", "uppercase tracking-[0.08em]")}>
                        Staging
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-caption tracking-normal text-mid-gray">
                    {s.url.replace(/^https?:\/\//, "")}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-4 text-body text-mid-gray">No site matches “{query}”.</li>
          )}
        </ul>
      </Modal>
    </>
  );
}
