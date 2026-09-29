import type { ReactNode } from "react";
import { cardClass } from "@/components/ui/styles";
import { statusInk, type StatusTone } from "@/components/ui/primitives";
import { SSL_WARN_DAYS, type FleetOverview } from "@/services/sites/overview";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One segment per bucket, widths in proportion; empty buckets draw nothing. */
function SegmentBar({ segments, label }: {
  segments: { value: number; className: string }[];
  label: string;
}) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  return (
    <div role="img" aria-label={label} className="flex h-2 w-full overflow-hidden rounded-full bg-canvas">
      {total > 0 && segments.map((s, i) =>
        s.value > 0 ? (
          <span key={i} className={s.className} style={{ width: `${(s.value / total) * 100}%` }} />
        ) : null)}
    </div>
  );
}

function Tile({ label, value, tone, hint, children, className }: {
  label: string;
  value: ReactNode;
  tone?: StatusTone;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${cardClass} flex flex-col gap-3 p-5 ${className ?? ""}`}>
      <p className="text-caption font-medium uppercase text-mid-gray">{label}</p>
      <p data-tabular className={`text-heading font-semibold leading-none ${tone ? statusInk(tone) : "text-ink"}`}>
        {value}
      </p>
      {children}
      {hint && <p className="mt-auto text-caption tracking-normal text-mid-gray">{hint}</p>}
    </div>
  );
}

const GRADE_BAR: { key: "A" | "B" | "C" | "D" | "F"; className: string }[] = [
  { key: "A", className: "bg-status-good" },
  { key: "B", className: "bg-status-good/60" },
  { key: "C", className: "bg-status-warn" },
  { key: "D", className: "bg-status-alert" },
  { key: "F", className: "bg-status-bad" },
];

/**
 * The summary band at the top of the dashboard: the whole portfolio in six
 * numbers, before any single site. Each tile answers one question an
 * operator asks on opening the panel (is anything down, is anything broken,
 * how much maintenance is waiting) and is computed from the same fields the
 * cards below display.
 */
export function FleetOverviewBand({ o }: { o: FleetOverview }) {
  const problems = o.critical + o.warn;
  const measured = o.up + o.down;

  return (
    <section aria-labelledby="overview-heading" className="mb-8">
      <h2 id="overview-heading" className="sr-only">Portfolio overview</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Tile
          className="col-span-2"
          label="Portfolio health"
          value={problems === 0 ? `All ${o.total} healthy` : `${o.healthy} of ${o.total} healthy`}
          tone={o.critical > 0 ? "bad" : o.warn > 0 ? "warn" : "good"}
          hint={`${plural(o.live, "live site")} · ${plural(o.staging, "staging copy", "staging copies")}`
            + (o.disabled > 0 ? ` · ${o.disabled} disabled` : "")}
        >
          <SegmentBar
            label={`${o.critical} critical, ${o.warn} warning, ${o.healthy} healthy`}
            segments={[
              { value: o.critical, className: "bg-status-bad" },
              { value: o.warn, className: "bg-status-warn" },
              { value: o.healthy, className: "bg-status-good" },
            ]}
          />
          {problems > 0 && (
            <p className="text-caption tracking-normal text-mid-gray">
              {o.critical > 0 && <span className={statusInk("bad")}>{o.critical} critical</span>}
              {o.critical > 0 && o.warn > 0 && " · "}
              {o.warn > 0 && <span className={statusInk("warn")}>{o.warn} warning</span>}
            </p>
          )}
        </Tile>

        <Tile
          className="col-span-2"
          label="Uptime now"
          value={measured === 0 ? "—" : `${o.up} / ${measured} up`}
          tone={measured === 0 ? undefined : o.down > 0 ? "bad" : "good"}
          hint={
            (o.averageUptime === null ? "No uptime checks in the last 24 hours" : `${o.averageUptime}% average over 24 hours`)
            + (o.unmeasured > 0 ? ` · ${o.unmeasured} not yet checked` : "")
          }
        >
          <SegmentBar
            label={`${o.up} up, ${o.down} down, ${o.unmeasured} not checked`}
            segments={[
              { value: o.down, className: "bg-status-bad" },
              { value: o.up, className: "bg-status-good" },
              { value: o.unmeasured, className: "bg-hairline" },
            ]}
          />
        </Tile>

        <Tile
          className="col-span-2"
          label="Security grades"
          value={o.grades.D + o.grades.F > 0 ? `${o.grades.D + o.grades.F} below C` : o.grades.none === o.total ? "—" : "No D or F"}
          tone={o.grades.F > 0 ? "bad" : o.grades.D > 0 ? "alert" : o.grades.none === o.total ? undefined : "good"}
          hint={GRADE_BAR.map((g) => `${g.key} ${o.grades[g.key]}`).join(" · ")
            + (o.grades.none > 0 ? ` · ${o.grades.none} not scanned` : "")}
        >
          <SegmentBar
            label={GRADE_BAR.map((g) => `${o.grades[g.key]} graded ${g.key}`).join(", ")}
            segments={GRADE_BAR.map((g) => ({ value: o.grades[g.key], className: g.className }))}
          />
        </Tile>

        <Tile
          className="col-span-1 lg:col-span-2"
          label="Updates waiting"
          value={o.updatesPending}
          tone={o.updatesPending > 0 ? "warn" : "good"}
          hint={o.updatesPending > 0 ? `Across ${plural(o.sitesWithUpdates, "site")}` : "Everything is up to date"}
        />

        <Tile
          className="col-span-1 lg:col-span-2"
          label="Average SEO"
          value={o.averageSeo ?? "—"}
          tone={o.averageSeo === null ? undefined : o.averageSeo >= 80 ? "good" : o.averageSeo >= 50 ? "warn" : "bad"}
          hint={o.averageSeo === null ? "No SEO audits yet" : "Out of 100, latest audit per site"}
        />

        <Tile
          className="col-span-2"
          label="SSL certificates"
          value={o.sslMeasured === 0 ? "—" : o.sslExpiring > 0 ? `${o.sslExpiring} expiring` : "All valid"}
          tone={o.sslMeasured === 0 ? undefined : o.sslExpiring > 0 ? "bad" : "good"}
          hint={o.sslMeasured === 0
            ? "No certificate readings in the last 24 hours"
            : `${o.sslMeasured} checked · flagged under ${SSL_WARN_DAYS} days left`}
        />
      </div>
    </section>
  );
}
