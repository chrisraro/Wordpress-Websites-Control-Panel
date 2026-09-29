import Link from "next/link";
import { LinkPending } from "@/components/shell/nav-progress";
import { StatusBadge, type StatusTone } from "@/components/ui/primitives";
import { badgeClass } from "@/components/ui/styles";
import type { DirectoryFields } from "@/services/sites/directory";
import { SitePreview } from "./site-preview";

export interface CatalogSite {
  id: string;
  fields: DirectoryFields;
  reasons: string[];
  gradeIncomplete: boolean;
  /** Search Console problem worth a badge, or null when fine/unmeasured. */
  gscProblem: "none" | "malformed" | null;
  /** Live homepage for the sandboxed frame; null = use the screenshot. */
  liveUrl: string | null;
  previewSrc: string | null;
}

const GRADE_TONE: Record<string, StatusTone> = { A: "good", B: "good", C: "warn", D: "alert", F: "bad" };

function seoTone(score: number): StatusTone {
  return score >= 80 ? "good" : score >= 50 ? "warn" : "bad";
}

function Availability({ f }: { f: DirectoryFields }) {
  if (f.status === "disabled") return <StatusBadge tone="idle">Disabled</StatusBadge>;
  if (f.up === false) return <StatusBadge tone="bad">Down</StatusBadge>;
  if (f.downUnconfirmed) return <StatusBadge tone="warn">Check failed</StatusBadge>;
  if (f.up === true) {
    return (
      <StatusBadge tone="good">
        Up{typeof f.uptime24h === "number" && <>&nbsp;·&nbsp;{f.uptime24h}%</>}
      </StatusBadge>
    );
  }
  return <StatusBadge tone="idle">Not checked</StatusBadge>;
}

/**
 * One site in the directory catalog: its homepage, its environment, and the
 * few numbers that say whether it needs anything.
 *
 * The environment label is on every card, both ways. PRODUCT.md names acting
 * on the wrong environment as the expensive mistake this product can cause,
 * and with the Production/Staging tabs gone the label is what keeps the two
 * apart: Staging is the solid chip (the loudest mark on the card), Live the
 * quiet outline. Neither is a status colour, because an environment is a
 * category, not a health state.
 */
export function SiteCard({ site }: { site: CatalogSite }) {
  const { fields: f, reasons, gradeIncomplete, gscProblem } = site;
  const staging = f.env === "staging";
  const dot = f.severity === "critical" ? "bg-status-bad" : f.severity === "warn" ? "bg-status-warn"
    : f.status === "disabled" ? "bg-mid-gray" : "bg-status-good";

  return (
    <li className="min-w-0">
      <Link
        href={`/sites/${site.id}`}
        className="group flex h-full flex-col overflow-hidden rounded-3xl border border-hairline bg-paper
          shadow-subtle transition-[box-shadow,transform] duration-200 ease-[var(--ease-out-quint)]
          hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2
          focus-visible:outline-ink"
      >
        <div className="relative aspect-[16/10] overflow-hidden border-b border-hairline bg-canvas">
          <SitePreview liveUrl={site.liveUrl} screenshotSrc={site.previewSrc} name={f.name} />
          {site.liveUrl && (
            <span className={`absolute bottom-3 left-3 ${badgeClass("outline", "bg-paper/90 backdrop-blur-sm")}`}>
              <span aria-hidden className="size-1.5 rounded-full bg-status-good" />
              Live view
            </span>
          )}
          <span
            className={`absolute left-3 top-3 ${staging
              ? badgeClass("solid", "uppercase tracking-[0.08em] shadow-subtle")
              : badgeClass("outline", "bg-paper/90 uppercase tracking-[0.08em] backdrop-blur-sm")}`}
          >
            {staging ? "Staging" : "Live"}
          </span>
          <span className="absolute right-3 top-3 rounded-2xl bg-paper/90 backdrop-blur-sm">
            <Availability f={f} />
          </span>
        </div>

        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="flex items-start gap-2">
            <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${dot}`} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium text-ink">{f.name}</p>
              <p className="truncate text-caption tracking-normal text-mid-gray">
                {f.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                {f.clientLabel && ` · ${f.clientLabel}`}
              </p>
            </div>
            <LinkPending spinner />
          </div>

          {f.severity !== "ok" && reasons.length > 0 && (
            <ul className="space-y-0.5">
              {reasons.slice(0, 2).map((r) => (
                <li
                  key={r}
                  className={`text-caption tracking-normal ${
                    f.severity === "critical" ? "text-status-bad" : "text-status-warn"}`}
                >
                  {r}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-auto flex flex-wrap gap-1.5">
            {f.grade && (
              <StatusBadge tone={GRADE_TONE[f.grade] ?? "idle"}>
                Security&nbsp;{f.grade}{gradeIncomplete && <>&nbsp;·&nbsp;incomplete</>}
              </StatusBadge>
            )}
            {f.updates !== undefined && f.updates > 0 && (
              <StatusBadge tone="warn">{f.updates}&nbsp;update{f.updates === 1 ? "" : "s"}</StatusBadge>
            )}
            {f.seo !== undefined && <StatusBadge tone={seoTone(f.seo)}>SEO&nbsp;{f.seo}</StatusBadge>}
            {gscProblem === "none" && <StatusBadge tone="warn">No GSC</StatusBadge>}
            {gscProblem === "malformed" && <StatusBadge tone="bad">GSC broken</StatusBadge>}
          </div>
        </div>
      </Link>
    </li>
  );
}
