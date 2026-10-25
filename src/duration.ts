// Prometheus durations: one or more <number><unit> pairs, largest unit first, e.g. 1h30m, 90s, 2w.
const unitMs = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
} as const;
type Unit = keyof typeof unitMs;
const order: Unit[] = ["y", "w", "d", "h", "m", "s", "ms"];

/** Parses a Prometheus duration into milliseconds, or returns undefined if it is not one. */
export function parseDuration(s: string): number | undefined {
  if (s === "0") return 0;
  const re = /(\d+)(ms|[smhdwy])/g;
  let total = 0;
  let consumed = 0;
  let last = -1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index !== consumed) return undefined;
    const unit = m[2] as Unit;
    const rank = order.indexOf(unit);
    if (rank <= last) return undefined; // units must go from largest to smallest, each at most once
    last = rank;
    total += Number(m[1]) * unitMs[unit];
    consumed += m[0].length;
  }
  return consumed === s.length && consumed > 0 ? total : undefined;
}

export function formatDuration(ms: number): string {
  for (const unit of order) {
    if (ms >= unitMs[unit] && ms % unitMs[unit] === 0) return `${String(ms / unitMs[unit])}${unit}`;
  }
  return `${String(ms)}ms`;
}
