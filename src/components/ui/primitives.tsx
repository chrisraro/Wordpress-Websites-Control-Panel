import type { ReactNode } from "react";
import { badgeClass, cardClass } from "./styles";

/* =========================================================================
   Status vocabulary
   The interface stays monochrome; status colour appears only as a 6px mark
   inside an otherwise neutral capsule, or as the ink of a datum that IS the
   measurement (a security grade, a rank). See the note in globals.css.
   ========================================================================= */

export type StatusTone = "good" | "warn" | "alert" | "bad" | "info" | "idle";

const DOT: Record<StatusTone, string> = {
  good: "bg-status-good",
  warn: "bg-status-warn",
  alert: "bg-status-alert",
  bad: "bg-status-bad",
  info: "bg-status-info",
  idle: "bg-mid-gray",
};

const INK: Record<StatusTone, string> = {
  good: "text-status-good",
  warn: "text-status-warn",
  alert: "text-status-alert",
  bad: "text-status-bad",
  info: "text-status-info",
  idle: "text-mid-gray",
};

export function statusInk(tone: StatusTone): string {
  return INK[tone];
}

export function StatusBadge({
  tone, children, className,
}: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={badgeClass("soft", className)}>
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

/* ========================================================================= */

export function Card({
  children, className, as: Tag = "section",
}: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <Tag className={`${cardClass} ${className ?? ""}`}>{children}</Tag>;
}

export function CardTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-4">
      <h2 className="text-body font-medium text-ink">{children}</h2>
      {aside}
    </div>
  );
}

/**
 * Metric display. DESIGN.md's Stat Block leans on the type scale rather than
 * card chrome, so this ships without a border by default; `boxed` opts into
 * the card treatment where a metric sits alone on the canvas.
 */
export function Stat({
  label, value, hint, tone, boxed = true,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatusTone;
  boxed?: boolean;
}) {
  return (
    <div className={boxed ? `${cardClass} p-5` : ""}>
      <p className="text-caption font-medium uppercase text-mid-gray">{label}</p>
      <p
        data-tabular
        className={`mt-1 text-heading-sm font-semibold ${tone ? INK[tone] : "text-ink"}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-caption tracking-normal text-mid-gray">{hint}</p>}
    </div>
  );
}

/**
 * Empty states teach the surface rather than announcing absence: what this
 * area will hold, and the one control that fills it.
 */
export function EmptyState({
  icon, title, children, action,
}: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      {icon && (
        <span aria-hidden className="text-mid-gray">
          {icon}
        </span>
      )}
      <p className="text-body font-medium text-ink">{title}</p>
      {children && <p className="max-w-sm text-body text-mid-gray">{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={`skeleton block rounded-2xl ${className ?? ""}`} />;
}

/** Page heading block — one shape for every route. */
export function PageHeader({
  title, subtitle, actions,
}: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-heading-sm font-semibold text-ink">{title}</h1>
        {subtitle && <div className="mt-1 text-body text-mid-gray">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
