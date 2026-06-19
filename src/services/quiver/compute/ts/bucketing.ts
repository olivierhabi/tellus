/**
 * B8 — Display-time bucketing (B8 C-02).
 *
 * Reduces a series to ≤ N buckets using a deterministic equal-width strategy
 * over the time range, applying the chosen bucket operation per bucket.
 *
 * The 1000-bucket cap is enforced as a hard ceiling: callers requesting
 * more buckets are silently capped (defensive downsample). The bucket op
 * defaults to "avg".
 */

import type { BucketOp, SeriesPoint } from "./codexPort";

export const MAX_BUCKETS = 1000;

export function bucketSeries(
  points: ReadonlyArray<SeriesPoint>,
  buckets: number,
  op: BucketOp = "avg",
): SeriesPoint[] {
  if (points.length === 0) return [];
  const n = Math.min(Math.max(1, Math.floor(buckets)), MAX_BUCKETS);
  if (points.length <= n) return [...points];
  const fromTs = points[0].ts;
  const toTs = points[points.length - 1].ts;
  const span = toTs - fromTs;
  if (span <= 0) return [{ ts: fromTs, value: applyOp(points.map((p) => p.value), op) }];
  const width = span / n;
  const slots: number[][] = Array.from({ length: n }, () => []);
  for (const p of points) {
    let idx = Math.floor((p.ts - fromTs) / width);
    if (idx >= n) idx = n - 1;
    if (idx < 0) idx = 0;
    slots[idx].push(p.value);
  }
  const out: SeriesPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (slots[i].length === 0) continue;
    out.push({ ts: fromTs + width * (i + 0.5), value: applyOp(slots[i], op) });
  }
  return out;
}

function applyOp(values: number[], op: BucketOp): number {
  if (values.length === 0) return 0;
  switch (op) {
    case "avg":   return values.reduce((a, b) => a + b, 0) / values.length;
    case "sum":   return values.reduce((a, b) => a + b, 0);
    case "min":   return Math.min(...values);
    case "max":   return Math.max(...values);
    case "first": return values[0];
    case "last":  return values[values.length - 1];
  }
}
