export interface VulnRange {
  from_version: string;
  from_inclusive: boolean;
  to_version: string;
  to_inclusive: boolean;
}

/** Split "1.2.3-beta1" into numeric segments plus an optional suffix. */
function parse(v: string): { nums: number[]; suffix: string } {
  const [main, ...rest] = v.trim().split("-");
  const nums = main.split(".").map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  return { nums, suffix: rest.join("-").toLowerCase() };
}

export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // Same numeric core: a suffix (beta/rc) sorts before the bare release.
  if (pa.suffix && !pb.suffix) return -1;
  if (!pa.suffix && pb.suffix) return 1;
  if (pa.suffix !== pb.suffix) return pa.suffix < pb.suffix ? -1 : 1;
  return 0;
}

export function versionInRange(version: string, range: VulnRange): boolean {
  if (range.from_version !== "*") {
    const c = compareVersions(version, range.from_version);
    if (c < 0 || (c === 0 && !range.from_inclusive)) return false;
  }
  if (range.to_version !== "*") {
    const c = compareVersions(version, range.to_version);
    if (c > 0 || (c === 0 && !range.to_inclusive)) return false;
  }
  return true;
}
