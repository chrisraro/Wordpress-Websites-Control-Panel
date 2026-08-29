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

/**
 * Copies a literal string as-is — for values like a WordPress username that
 * are not part of this app's URL space. `CopyLinkButton` builds an absolute
 * URL from a path, which would be the wrong job for a plain value.
 */
export function CopyValueButton({
  value, label = "Copy", size = "sm",
}: { value: string; label?: string; size?: ButtonSize }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ tone: "success", title: "Copied", description: value });
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({
        tone: "error",
        title: "Could not copy",
        description: "Your browser blocked clipboard access — copy the value manually.",
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
