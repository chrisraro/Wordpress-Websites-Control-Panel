/**
 * The decorative rank lattice on the login panel.
 *
 * This is the product drawn as geometry, not an ornament: 81 points is exactly
 * what a 9x9 GeoGrid run measures (see grid_size in 0001_init.sql), and the
 * bands below map to the same thresholds the real map uses — 1-3 strong, 4-10
 * mid, 11-20 weak, unmeasured dim. Someone who has seen the GeoGrid tab
 * recognises this; someone who hasn't still reads "signal across a territory".
 *
 * Deterministic by construction. A random layout would differ between the
 * server and client renders and trip a hydration mismatch, so the rank comes
 * from an integer hash of the coordinates — stable across renders, varied
 * enough not to read as a pattern.
 *
 * Brand colour lives here and nowhere else in the app. DESIGN.md reserves hue
 * for data, and this panel is the one surface that is pure brand; the form
 * beside it stays monochrome, and nothing behind the sign-in gate changes.
 */

const SIZE = 9;
const SPAN = 100 / (SIZE + 1);

/** Cheap integer hash — deterministic, and cheap enough to run at module scope. */
function hash(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

type Point = { cx: number; cy: number; r: number; fill: string; dim: number; i: number };

const POINTS: Point[] = (() => {
  const out: Point[] = [];
  // Signal is strongest near the business and falls off with distance, the
  // shape every real local-rank map has.
  const fx = 0.42, fy = 0.46;
  for (let gy = 0; gy < SIZE; gy++) {
    for (let gx = 0; gx < SIZE; gx++) {
      const nx = gx / (SIZE - 1), ny = gy / (SIZE - 1);
      const dist = Math.hypot(nx - fx, ny - fy) / 0.72;
      const score = dist * 0.78 + hash(gx, gy) * 0.42;

      // Size and strength both fall off, and the weakest band nearly
      // disappears. An even spread of visible dots reads as wallpaper; the
      // point of a rank map is that you can see where the signal peaks.
      let fill: string, r: number, dim: number;
      if (score < 0.28) { fill = "#00fff9"; r = 1.9; dim = 1; }
      else if (score < 0.46) { fill = "#e6ff38"; r = 1.5; dim = 0.92; }
      else if (score < 0.68) { fill = "#e6ff38"; r = 1.0; dim = 0.42; }
      else { fill = "#e6ff38"; r = 0.6; dim = 0.13; }

      out.push({
        cx: (gx + 1) * SPAN,
        cy: (gy + 1) * SPAN,
        r, fill, dim,
        // Radial index, so the field resolves outward from the business —
        // the order the data actually arrives in. The `grid-point` utility
        // turns this into the same capped stagger the real GeoGrid map uses.
        i: Math.round(dist * 26),
      });
    }
  }
  return out;
})();

export function GeoGridField({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      focusable="false"
      className={className}
    >
      {POINTS.map((p, idx) => (
        <circle
          key={idx}
          cx={p.cx}
          cy={p.cy}
          r={p.r}
          fill={p.fill}
          // Rank dimming rides on fill-opacity, not opacity: the entrance
          // keyframe animates opacity to 1, and would otherwise flatten every
          // band to full strength the moment it landed.
          fillOpacity={p.dim}
          className="grid-point"
          style={{ "--i": p.i } as React.CSSProperties}
        />
      ))}
    </svg>
  );
}
