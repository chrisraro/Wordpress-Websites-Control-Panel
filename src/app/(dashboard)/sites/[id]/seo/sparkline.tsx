export function Sparkline({
  points, label,
}: { points: Array<{ at: string; value: number }>; label: string }) {
  if (points.length < 2) {
    return (
      <p className="text-caption tracking-normal text-mid-gray">
        Two scans are needed before a trend appears.
      </p>
    );
  }
  const w = 240;
  const h = 48;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * (w - 4) + 2;
    const y = h - 4 - ((p.value - min) / span) * (h - 8);
    return { x, y };
  });
  const path = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const delta = last.value - first.value;
  const tip = coords[coords.length - 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-12 w-full max-w-60 text-ink"
        role="img"
        aria-label={`${label}: ${first.value} on ${new Date(first.at).toLocaleDateString()}, ${last.value} on ${new Date(last.at).toLocaleDateString()}`}
      >
        <polyline
          points={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* The latest reading is the one being read; mark where the eye lands. */}
        <circle cx={tip.x} cy={tip.y} r="2.5" fill="currentColor" />
      </svg>
      <p className="mt-1 text-caption tracking-normal text-mid-gray">
        {points.length} runs ·{" "}
        {delta === 0
          ? "no change"
          : `${delta > 0 ? "+" : ""}${delta} since ${new Date(first.at).toLocaleDateString()}`}
      </p>
    </div>
  );
}
