"use client";

import { useEffect, useRef } from "react";
import type { RankPoint } from "@/services/geogrid/types";

function colourFor(rank: number | null): string {
  if (rank === null) return "#dc2626";      // not found
  if (rank <= 3) return "#16a34a";
  if (rank <= 7) return "#65a30d";
  if (rank <= 10) return "#ca8a04";
  if (rank <= 15) return "#ea580c";
  return "#dc2626";
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
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      for (const p of points) {
        const label = p.rank === null ? "20+" : String(p.rank);
        L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: "",
            html: `<div style="background:${colourFor(p.rank)};color:#fff;border-radius:9999px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font:600 12px system-ui;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">${label}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
        }).addTo(map).bindPopup(`${businessName}<br>Rank: ${label}`);
      }

      L.circleMarker([center.lat, center.lng], {
        radius: 4, color: "#0f172a", weight: 2, fillOpacity: 1,
      }).addTo(map).bindPopup("Grid centre");

      map.fitBounds(points.map((p) => [p.lat, p.lng] as [number, number]), { padding: [24, 24] });
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [points, center.lat, center.lng, businessName]);

  if (points.length === 0) {
    return (
      <div className="flex h-80 items-center justify-center rounded-lg border border-dashed bg-white text-sm text-slate-500">
        No results yet — run a scan to plot the grid.
      </div>
    );
  }
  return <div ref={ref} className="h-80 w-full rounded-lg border sm:h-96" role="application"
    aria-label="GeoGrid rank map" />;
}
