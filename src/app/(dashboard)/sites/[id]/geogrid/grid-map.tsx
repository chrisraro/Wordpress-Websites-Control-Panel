"use client";

import { useEffect, useRef } from "react";
import type { RankPoint } from "@/services/geogrid/types";

/**
 * Reads a design token off the document.
 *
 * Leaflet paints into its own DOM with inline styles, so it cannot use
 * Tailwind classes and needs literal colour strings. Resolving them from CSS
 * custom properties keeps globals.css the single source of truth: this file
 * used to carry its own copies, and its mid-gray was still #737373 long after
 * the token was darkened to #707070 to clear the contrast floor — the map had
 * silently drifted from the rest of the app.
 *
 * The fallback is only for the case where the stylesheet has not applied
 * (a token renamed, CSS failing to load); an unreadable token should leave a
 * visible marker rather than an invisible one.
 */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Popup content as real DOM so untrusted text can never become markup. */
function popupNode(businessName: string, label: string, measured: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.font = "500 13px var(--font-geist, system-ui)";
  const name = document.createElement("strong");
  name.textContent = businessName;
  const rank = document.createElement("div");
  rank.style.color = token("--color-mid-gray", "#707070");
  rank.textContent = measured ? `Rank: ${label}` : "Not measured — lookup failed";
  wrap.append(name, rank);
  return wrap;
}

/**
 * The rank ramp is the one place colour carries the whole meaning, so it uses
 * the `--color-rank-*` scale from globals.css rather than the monochrome
 * chrome. An unmeasured point gets mid-gray, not the "outside the top 20"
 * red: a failed lookup carries no information about whether the business
 * ranks there, and colouring it the same as a confirmed non-rank would say
 * otherwise.
 */
function colourFor(rank: number | null, measured: boolean): string {
  if (!measured) return token("--color-rank-unmeasured", "#707070");
  if (rank === null) return token("--color-rank-5", "#b91c1c");
  if (rank <= 3) return token("--color-rank-1", "#15803d");
  if (rank <= 7) return token("--color-rank-2", "#4d7c0f");
  if (rank <= 10) return token("--color-rank-3", "#a16207");
  if (rank <= 15) return token("--color-rank-4", "#c2410c");
  return token("--color-rank-5", "#b91c1c");
}

export function GridMap({
  points, center, businessName,
}: { points: RankPoint[]; center: { lat: number; lng: number }; businessName: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current || points.length === 0) return;
    let cancelled = false;
    let map: import("leaflet").Map | null = null;

    // Leaflet touches window on import, so it loads only in the browser.
    void (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      if (cancelled || !ref.current) return;

      map = L.map(ref.current, { scrollWheelZoom: false, attributionControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      points.forEach((p, i) => {
        const measured = p.measured !== false;
        const label = !measured ? "?" : p.rank === null ? "20+" : String(p.rank);
        L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: "",
            // The focal moment: points land in reading order, so the map reads
            // as a measurement being taken rather than an image appearing.
            // --i drives the stagger; the delay is capped in globals.css so a
            // 9×9 grid never outlasts the glance it exists to serve.
            html:
              `<div class="grid-point" style="--i:${i};background:${colourFor(p.rank, measured)};` +
              `color:#fff;border-radius:9999px;width:28px;height:28px;display:flex;` +
              `align-items:center;justify-content:center;` +
              `font:600 12px var(--font-geist, system-ui);border:2px solid #fff;` +
              `box-shadow:0 1px 3px rgba(0,0,0,.35)">${label}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        })
          .addTo(map!)
          // Built as DOM, not an HTML string: Leaflet assigns string popup
          // content via innerHTML, and the business name is user-entered.
          .bindPopup(popupNode(businessName, label, measured));
      });

      L.circleMarker([center.lat, center.lng], {
        radius: 4, color: token("--color-ink", "#0a0a0a"), weight: 2, fillOpacity: 1,
      })
        .addTo(map)
        .bindPopup("Grid centre");

      map.fitBounds(points.map((p) => [p.lat, p.lng] as [number, number]), { padding: [24, 24] });
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [points, center.lat, center.lng, businessName]);

  if (points.length === 0) {
    return (
      <div
        className="flex h-80 items-center justify-center rounded-3xl border border-dashed
          border-hairline bg-paper px-6 text-center text-body text-mid-gray sm:h-96"
      >
        No results plotted yet — run a scan to measure this grid.
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="h-80 w-full overflow-hidden rounded-3xl border border-hairline sm:h-96"
      role="application"
      aria-label="GeoGrid rank map"
    />
  );
}
