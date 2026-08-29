"use client";

import { useState } from "react";
import { buttonClass, type ButtonSize } from "./styles";
import { IconCheck, IconLink } from "./icons";
import { useToast } from "./toast";

/**
 * Copies an absolute URL built from the current origin, so a link copied from
 * localhost is a localhost link and one copied from production is shareable.
 */
export function CopyLinkButton({
  path, label = "Copy link", size = "sm",
}: { path: string; label?: string; size?: ButtonSize }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const copy = async () => {
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast({ tone: "success", title: "Link copied", description: url });
      // Long enough to register, short enough that the button is ready again
      // before a second click.
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({
        tone: "error",
        title: "Could not copy",
        description: "Your browser blocked clipboard access — copy the link from the address bar.",
      });
    }
  };

  return (
    <button type="button" onClick={copy} className={buttonClass("outline", size)}>
      {copied ? <IconCheck size={14} /> : <IconLink size={14} />}
      {copied ? "Copied" : label}
    </button>
  );
}
