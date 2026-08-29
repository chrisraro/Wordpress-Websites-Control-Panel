/**
 * Shared class vocabulary for the design system in DESIGN.md.
 *
 * These are plain functions rather than components so Server Components can
 * style native elements (links, table cells, form controls) with exactly the
 * same tokens a client component uses. One definition per element type is the
 * point: if the Save button looks different on two screens, one of them is a
 * bug, not a variation.
 */

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl " +
  "font-medium transition-[background-color,color,box-shadow,transform] duration-150 " +
  "ease-[var(--ease-out-quint)] active:scale-[0.98] " +
  "disabled:pointer-events-none disabled:opacity-50 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-ink text-surface-alt hover:bg-ink-soft",
  secondary: "bg-canvas text-ink hover:bg-hairline",
  outline: "border border-hairline bg-transparent text-ink hover:bg-canvas",
  ghost: "bg-transparent text-mid-gray hover:bg-canvas hover:text-ink",
  // Destructive stays a hairline control with ember text: DESIGN.md reserves
  // the hue for the meaning, and a fully filled red button shouts louder than
  // the monochrome system ever does.
  danger: "border border-hairline bg-transparent text-ember hover:bg-ember/[0.06]",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-caption tracking-normal",
  md: "min-h-10 px-4 text-body",
};

export function buttonClass(
  variant: ButtonVariant = "outline",
  size: ButtonSize = "md",
  extra?: string,
): string {
  return [BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], extra]
    .filter(Boolean)
    .join(" ");
}

/** Card: hairline + whisper shadow together — DESIGN.md requires both. */
export const cardClass =
  "rounded-3xl border border-hairline bg-paper shadow-subtle";

/** Header or footer strip inside a card. */
export const cardHeaderClass =
  "border-b border-hairline px-5 py-4 text-body font-medium";

export const cardFooterClass =
  "border-t border-hairline px-5 py-3 text-caption tracking-normal text-mid-gray";

/** Resting fill, hairline ring on focus — no border at rest. */
export const inputClass =
  "min-h-10 w-full rounded-2xl border border-transparent bg-canvas px-4 py-2 " +
  "text-body text-ink placeholder:text-mid-gray transition-colors duration-150 " +
  "focus:border-hairline focus:bg-paper focus:outline-none " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export const labelClass = "block text-body font-medium text-ink";

export const hintClass = "text-caption tracking-normal text-mid-gray";

export type BadgeTone = "solid" | "soft" | "outline";

const BADGE_TONE: Record<BadgeTone, string> = {
  solid: "bg-ink-soft text-surface-alt",
  soft: "bg-canvas text-ink-soft",
  outline: "border border-hairline text-ink",
};

export function badgeClass(tone: BadgeTone = "soft", extra?: string): string {
  return [
    "inline-flex items-center gap-1.5 rounded-2xl px-2 py-0.5 text-caption",
    "font-medium tracking-normal whitespace-nowrap",
    BADGE_TONE[tone],
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

export const tableHeadClass =
  "border-b border-hairline text-left text-caption font-medium uppercase text-mid-gray";

export const tableCellClass = "px-5 py-3 text-body";

/** Rows lift a half-tone on hover so a wide table stays trackable. */
export const tableRowClass =
  "border-b border-hairline last:border-0 transition-colors duration-150 hover:bg-surface-alt";
