import type { ThemeInfo } from "@/services/inventory/types";
import { ALLOWED, refuse, type ThemeVerdict } from "./types";

/**
 * Whether a theme can be deleted without breaking the site.
 *
 * A parent theme reports status "inactive" while its child is the active
 * theme, so "inactive" alone is not a safe test — deleting the parent of an
 * active child takes the site down immediately. Four distinct refusals, each
 * with copy the UI can show verbatim.
 */
export function canDeleteTheme(themes: ThemeInfo[], slug: string): ThemeVerdict {
  const target = themes.find((t) => t.name === slug);
  if (!target) return refuse("That theme is not installed on this site.");

  // Snapshots taken before parentage was collected cannot be reasoned about.
  // Fail closed: one refresh is cheaper than an orphaned child theme.
  if (themes.some((t) => typeof t.template !== "string" || t.template === "")) {
    return refuse("Refresh the inventory first — this snapshot predates parent-theme tracking.");
  }

  if (themes.length <= 1) {
    return refuse("This is the only theme installed. WordPress needs one to fall back to.");
  }

  if (target.status === "active") {
    return refuse("This theme is active. Activate a different theme first.");
  }

  const active = themes.find((t) => t.status === "active");
  if (active && active.template === slug && active.name !== slug) {
    return refuse(`This is the parent of the active theme (${active.title || active.name}).`);
  }

  const child = themes.find((t) => t.name !== slug && t.template === slug);
  if (child) {
    return refuse(`This is the parent of ${child.title || child.name}, which would stop working.`);
  }

  return ALLOWED;
}

/** A child theme whose parent is absent produces a broken site on activation. */
export function canActivateTheme(themes: ThemeInfo[], slug: string): ThemeVerdict {
  const target = themes.find((t) => t.name === slug);
  if (!target) return refuse("That theme is not installed on this site.");

  const isChild = typeof target.template === "string" && target.template !== ""
    && target.template !== target.name;
  if (isChild && !themes.some((t) => t.name === target.template)) {
    return refuse(`Its parent theme (${target.template}) is not installed.`);
  }
  return ALLOWED;
}

/** Slugs that pass the delete gate — drives bulk-selection eligibility. */
export function deletableThemes(themes: ThemeInfo[]): string[] {
  return themes.filter((t) => canDeleteTheme(themes, t.name).allowed).map((t) => t.name);
}
