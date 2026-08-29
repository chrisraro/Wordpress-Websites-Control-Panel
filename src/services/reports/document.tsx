import React from "react";
import { Document, Page, Text, View, StyleSheet, type DocumentProps } from "@react-pdf/renderer";
import type { ReportData } from "./types";

const c = {
  ink: "#0f172a", muted: "#64748b", line: "#e2e8f0",
  good: "#16a34a", warn: "#ca8a04", bad: "#dc2626",
};

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 56, paddingHorizontal: 44, fontSize: 10, color: c.ink },
  brandBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end",
    borderBottomWidth: 2, borderBottomColor: c.ink, paddingBottom: 8, marginBottom: 18 },
  brand: { fontSize: 16, fontWeight: 700 },
  brandMeta: { fontSize: 9, color: c.muted, textAlign: "right" },
  h1: { fontSize: 22, marginBottom: 4 },
  sub: { fontSize: 10, color: c.muted, marginBottom: 22 },
  h2: { fontSize: 13, fontWeight: 700, marginTop: 18, marginBottom: 8,
    borderBottomWidth: 1, borderBottomColor: c.line, paddingBottom: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  label: { color: c.muted },
  tiles: { flexDirection: "row", gap: 8, marginBottom: 8 },
  tile: { flex: 1, borderWidth: 1, borderColor: c.line, borderRadius: 4, padding: 8, alignItems: "center" },
  tileValue: { fontSize: 15, fontWeight: 700 },
  tileLabel: { fontSize: 8, color: c.muted, marginTop: 2 },
  li: { flexDirection: "row", paddingVertical: 2 },
  bullet: { width: 10, color: c.muted },
  empty: { color: c.muted, fontStyle: "italic", paddingVertical: 4 },
  footer: { position: "absolute", bottom: 24, left: 44, right: 44, flexDirection: "row",
    justifyContent: "space-between", borderTopWidth: 1, borderTopColor: c.line,
    paddingTop: 6, fontSize: 8, color: c.muted },
});

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", {
  day: "2-digit", month: "short", year: "numeric",
}) : "—");

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <View style={s.tile}>
      <Text style={s.tileValue}>{value}</Text>
      <Text style={s.tileLabel}>{label}</Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <Text style={s.empty}>{empty}</Text>;
  return (
    <View>
      {items.map((text, i) => (
        <View style={s.li} key={i}>
          <Text style={s.bullet}>•</Text>
          <Text>{text}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * One line of the client-facing "Average rank by keyword" list. `coverage()`
 * returns 0 both for "measured everything, ranked nowhere" and "measured
 * nothing" — this function is what keeps the PDF from conflating those two
 * very different situations, and from ever printing a percentage computed
 * over a handful of surviving points as if it described the whole grid.
 */
export function geoGridKeywordLine(k: {
  keyword: string;
  averageRank: number | null;
  coverage: number;
  measured: number;
  total: number;
  runAt: string;
}): string {
  const rank = `${k.keyword} — average rank ${k.averageRank ?? "not ranked"}`;
  const when = fmtDate(k.runAt);
  if (k.measured === 0) {
    return `${rank}, not enough data — 0 of ${k.total} locations could be measured (${when})`;
  }
  if (k.measured < k.total) {
    return `${rank}, visible at ${k.coverage}% of locations — only ${k.measured} of ${k.total} could be measured (${when})`;
  }
  return `${rank}, visible at ${k.coverage}% of locations (${when})`;
}

// The element type must be ReactElement<DocumentProps>: renderToBuffer only
// accepts a <Document>, and a bare ReactElement fails to type-check at the call site.
export function ReportDocument(data: ReportData): React.ReactElement<DocumentProps> {
  const { meta, security, seo, geogrid, inventory } = data;
  return (
    <Document
      title={`${meta.siteName} — website report`}
      author="OCS"
      subject={`Website report for ${meta.siteName}`}
    >
      <Page size="A4" style={s.page}>
        <View style={s.brandBar}>
          <Text style={s.brand}>OCS — Website Report</Text>
          <Text style={s.brandMeta}>
            {fmtDate(meta.periodStart)} – {fmtDate(meta.periodEnd)}
            {"\n"}Generated {fmtDate(meta.generatedAt)}
          </Text>
        </View>

        <Text style={s.h1}>{meta.siteName}</Text>
        <Text style={s.sub}>{meta.siteUrl}</Text>

        {security && (
          <View>
            <Text style={s.h2}>Security</Text>
            <View style={s.tiles}>
              <Tile value={security.grade ?? "—"} label="Grade" />
              <Tile value={security.score === null ? "—" : `${security.score}/100`} label="Score" />
              <Tile value={String(security.openVulns)} label="Known vulnerabilities" />
              <Tile value={security.uptime24h === null ? "—" : `${security.uptime24h}%`} label="Uptime (24h)" />
            </View>
            <Row label="Critical vulnerabilities" value={String(security.criticalVulns)} />
            <Row label="SSL certificate expires in" value={security.sslDays === null ? "—" : `${security.sslDays} days`} />
            <Row label="Last scan" value={fmtDate(security.scannedAt)} />
            <Text style={{ marginTop: 8, marginBottom: 2 }}>Hardening items needing attention</Text>
            <Bullets
              items={security.failedChecks.map((c2) => `${c2.id.replace(/_/g, " ")} — ${c2.result}`)}
              empty="All hardening checks passed."
            />
          </View>
        )}

        {seo && (
          <View>
            <Text style={s.h2}>SEO &amp; AEO</Text>
            <View style={s.tiles}>
              <Tile value={seo.auditScore === null ? "—" : `${seo.auditScore}/100`} label="SEO audit" />
              <Tile value={seo.psiMobile === null ? "—" : String(seo.psiMobile)} label="Speed (mobile)" />
              <Tile value={seo.psiDesktop === null ? "—" : String(seo.psiDesktop)} label="Speed (desktop)" />
              <Tile value={String(seo.brands.length)} label="AI brands tracked" />
            </View>
            <Row label="Last scan" value={fmtDate(seo.scannedAt)} />
            <Text style={{ marginTop: 8, marginBottom: 2 }}>Issues to address</Text>
            <Bullets
              items={seo.failingFindings.map((f) => `${f.title} (${f.status})`)}
              empty="No failing SEO tests."
            />
            <Text style={{ marginTop: 8, marginBottom: 2 }}>Pages with the lowest scores</Text>
            <Bullets
              items={seo.worstPages.map((p) => `${p.title} — ${p.score ?? "unscored"}`)}
              empty="No page scores recorded."
            />
            <Text style={{ marginTop: 8, marginBottom: 2 }}>Top search queries</Text>
            <Bullets
              items={seo.topKeywords.map((k) => `${k.keyword} — ${k.clicks} clicks, position ${k.position.toFixed(1)}`)}
              empty={seo.keywordsConnected
                ? "No search impressions in this period."
                : "Google Search Console is not connected for this site."}
            />
          </View>
        )}

        <View style={s.footer} fixed>
          <Text>{meta.siteName} — confidential</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>

      {(geogrid || inventory) && (
        <Page size="A4" style={s.page}>
          <View style={s.brandBar}>
            <Text style={s.brand}>OCS — Website Report</Text>
            <Text style={s.brandMeta}>{meta.siteName}</Text>
          </View>

          {geogrid && (
            <View>
              <Text style={s.h2}>Local visibility (GeoGrid)</Text>
              <Row label="Business" value={geogrid.businessName ?? "Not configured"} />
              <Text style={{ marginTop: 8, marginBottom: 2 }}>Average rank by keyword</Text>
              <Bullets
                items={geogrid.keywords.map(geoGridKeywordLine)}
                empty="No GeoGrid scans recorded yet."
              />
            </View>
          )}

          {inventory && (
            <View>
              <Text style={s.h2}>Site inventory</Text>
              <View style={s.tiles}>
                <Tile value={inventory.wpVersion ?? "—"} label="WordPress" />
                <Tile value={inventory.phpVersion ?? "—"} label="PHP" />
                <Tile value={String(inventory.pluginCount)} label="Plugins" />
                <Tile value={String(inventory.pendingUpdates)} label="Pending updates" />
              </View>
              <Row label="WordPress core update available" value={inventory.coreUpdate ?? "Up to date"} />
              <Row label="Inventory collected" value={fmtDate(inventory.collectedAt)} />
            </View>
          )}

          <View style={s.footer} fixed>
            <Text>{meta.siteName} — confidential</Text>
            <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
          </View>
        </Page>
      )}
    </Document>
  );
}
