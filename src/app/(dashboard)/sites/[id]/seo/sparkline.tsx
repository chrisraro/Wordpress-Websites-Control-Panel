export function Sparkline({
  points, label,
}: { points: Array<{ at: string; value: number }>; label: string }) {
  if (points.length < 2) {
    return <p className="text-xs text-slate-400">Not enough history yet for a trend.</p>;
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
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = points[0];
  const last = points[points.length - 1];
  const delta = last.value - first.value;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full max-w-60" role="img"
        aria-label={`${label}: ${first.value} on ${new Date(first.at).toLocaleDateString()} to ${last.value} on ${new Date(last.at).toLocaleDateString()}`}>
        <polyline points={coords.join(" ")} fill="none" stroke="currentColor" strokeWidth="2"
          className="text-slate-700" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <p className="text-xs text-slate-500">
        {points.length} runs · {delta === 0 ? "no change" : `${delta > 0 ? "+" : ""}${delta} since ${new Date(first.at).toLocaleDateString()}`}
      </p>
    </div>
  );
}
