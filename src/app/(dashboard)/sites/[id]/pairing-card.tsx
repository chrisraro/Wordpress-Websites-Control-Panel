import Link from "next/link";
import { Card, CardTitle, StatusBadge } from "@/components/ui/primitives";
import { badgeClass } from "@/components/ui/styles";
import { IconChevronRight } from "@/components/ui/icons";
import { driftCount, type ComponentDrift, type InventoryDrift } from "@/services/sites/drift";

/**
 * "Compared with production: <name>" on a staging site's page
 * (0026_site_production_pair.sql, src/services/sites/drift.ts).
 *
 * Every row names which side it is describing in words -- "Staging" and
 * "Production" -- never by position alone. On a phone the two columns stack,
 * and a value that only means something because of which column it sits in
 * is exactly the staging/production confusion PRODUCT.md calls the most
 * expensive mistake this product can cause.
 */
export function PairingCard({
  production, drift, missing, stagingTakenAt, productionTakenAt,
}: {
  production: { id: string; name: string };
  /** Null when either side has no snapshot yet. */
  drift: InventoryDrift | null;
  /** Which side has no inventory, when drift is null. */
  missing: "staging" | "production" | "both" | null;
  stagingTakenAt: string | null;
  productionTakenAt: string | null;
}) {
  const count = drift ? driftCount(drift) : 0;
  return (
    <Card className="mb-6">
      <CardTitle
        aside={
          <Link
            href={`/sites/${production.id}`}
            className="inline-flex min-h-9 items-center gap-1 text-body text-mid-gray underline
              transition-colors duration-150 hover:text-ink pointer-coarse:min-h-11"
          >
            Open production site
            <IconChevronRight size={14} className="shrink-0" />
          </Link>
        }
      >
        Compared with production: {production.name}
      </CardTitle>

      {!drift ? (
        // Not compared is its own state. "In sync" here would claim a match
        // nobody has measured.
        <div className="px-5 py-4">
          <StatusBadge tone="idle">Not compared yet</StatusBadge>
          <p className="mt-2 text-body text-mid-gray">
            {missing === "production"
              ? `${production.name} has no inventory yet. Refresh its inventory, then come back.`
              : missing === "staging"
                ? "This staging site has no inventory yet. Refresh its inventory to compare."
                : "Neither site has inventory yet. Refresh both to compare."}
          </p>
        </div>
      ) : drift.inSync ? (
        <div className="px-5 py-4">
          <StatusBadge tone="good">In sync</StatusBadge>
          <p className="mt-2 text-body text-mid-gray">
            WordPress, PHP, plugins and themes match the production site.
          </p>
          <SnapshotTimes staging={stagingTakenAt} production={productionTakenAt} />
        </div>
      ) : (
        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="warn">
              {count} difference{count === 1 ? "" : "s"}
            </StatusBadge>
            <p className="text-body text-mid-gray">This staging copy has drifted from production.</p>
          </div>

          {(drift.core || drift.php) && (
            <dl className="mt-4 divide-y divide-hairline text-body">
              {drift.core && (
                <VersionRow term="WordPress" staging={drift.core.staging} production={drift.core.production} />
              )}
              {drift.php && (
                <VersionRow term="PHP" staging={drift.php.staging} production={drift.php.production} />
              )}
            </dl>
          )}

          <ComponentSection title="Plugins" drift={drift.plugins} />
          <ComponentSection title="Themes" drift={drift.themes} />

          <SnapshotTimes staging={stagingTakenAt} production={productionTakenAt} />
        </div>
      )}
    </Card>
  );
}

function SideLabel({ side }: { side: "staging" | "production" }) {
  return side === "staging" ? (
    <span className={badgeClass("solid", "uppercase tracking-[0.08em]")}>Staging</span>
  ) : (
    <span className={badgeClass("outline")}>Production</span>
  );
}

function VersionRow({ term, staging, production }: { term: string; staging: string; production: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
      <dt className="text-mid-gray">{term}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-ink">
        <SideLabel side="staging" /> {staging}
        <span className="text-mid-gray">vs</span>
        <SideLabel side="production" /> {production}
      </dd>
    </div>
  );
}

function ComponentSection({ title, drift }: { title: string; drift: ComponentDrift }) {
  const groups: { heading: string; items: { key: string; text: string }[] }[] = [
    {
      heading: "Only on staging",
      items: drift.onlyOnStaging.map((i) => ({
        key: i.key, text: `${i.label} ${i.version}${i.active ? "" : " (inactive)"}`,
      })),
    },
    {
      heading: "Only on production",
      items: drift.onlyOnProduction.map((i) => ({
        key: i.key, text: `${i.label} ${i.version}${i.active ? "" : " (inactive)"}`,
      })),
    },
    {
      heading: "Different version",
      items: drift.versionDiffers.map((i) => ({
        key: i.key, text: `${i.label}: staging ${i.staging}, production ${i.production}`,
      })),
    },
    {
      heading: "Active on one side only",
      items: drift.activeDiffers.map((i) => ({
        key: i.key,
        text: `${i.label}: ${i.stagingActive ? "active" : "inactive"} on staging, ${
          i.productionActive ? "active" : "inactive"
        } on production`,
      })),
    },
  ].filter((g) => g.items.length > 0);

  if (groups.length === 0) return null;
  return (
    <section className="mt-4">
      <h3 className="text-body font-medium text-ink">{title}</h3>
      <div className="mt-2 space-y-3">
        {groups.map((g) => (
          <div key={g.heading}>
            <p className="text-caption uppercase text-mid-gray">
              {g.heading} ({g.items.length})
            </p>
            <ul className="mt-1 space-y-0.5 text-body text-ink">
              {g.items.map((i) => (
                <li key={i.key} className="break-words">{i.text}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function SnapshotTimes({ staging, production }: { staging: string | null; production: string | null }) {
  if (!staging || !production) return null;
  return (
    <p className="mt-4 text-caption tracking-normal text-mid-gray">
      Compared inventory taken {new Date(staging).toLocaleString()} (staging) and{" "}
      {new Date(production).toLocaleString()} (production).
    </p>
  );
}

/**
 * On a production site's page: the staging copies that point at it. Small on
 * purpose -- the drift itself lives on the staging page -- but every link
 * carries the STAGING chip so a tap from here can never be mistaken for
 * staying on production.
 */
export function StagingPairsLinks({ pairs }: { pairs: { id: string; name: string }[] }) {
  if (pairs.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-mid-gray">
      <span>Staging {pairs.length === 1 ? "copy" : "copies"}:</span>
      {pairs.map((p) => (
        <Link
          key={p.id}
          href={`/sites/${p.id}`}
          className="inline-flex min-h-9 items-center gap-2 text-ink underline transition-colors
            duration-150 hover:text-mid-gray pointer-coarse:min-h-11"
        >
          <span className={badgeClass("solid", "uppercase tracking-[0.08em]")}>Staging</span>
          {p.name}
        </Link>
      ))}
    </div>
  );
}
