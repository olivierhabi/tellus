/**
 * Polars-backed aggregator.
 *
 * The spec calls Polars "the recommended default for production transforms"
 * (Polars → DuckDB → Spark in priority order). This wrapper takes the rows
 * already returned from Postgres / OpenSearch and runs in-process group-by /
 * histogram / value-count operations on them. Polars on a single node
 * comfortably handles 50 GB / 200 M rows; for the toy datasets we work
 * with locally it is effectively instantaneous.
 */

import pl from 'nodejs-polars';

export interface ListogramBucket {
  value: string;
  count: number;
}

export interface HistogramBucket {
  bucket: number;
  start: number;
  end: number;
  count: number;
}

/** Top-N value frequency for any field (the Listogram chart). */
export function listogram(
  rows: Record<string, unknown>[],
  field: string,
  topN = 10,
): ListogramBucket[] {
  if (rows.length === 0) return [];
  const series = rows.map((r) => (r[field] == null ? null : String(r[field])));
  const df = pl.DataFrame({ value: series });
  const grouped = df
    .filter(pl.col('value').isNotNull())
    .groupBy('value')
    .agg(pl.col('value').count().alias('count'))
    .sort('count', true)
    .head(topN);
  return grouped.toRecords() as unknown as ListogramBucket[];
}

/** Bucketed numeric histogram for the chart-per-property panel. */
export function histogram(
  rows: Record<string, unknown>[],
  field: string,
  buckets = 10,
): HistogramBucket[] {
  const nums = rows
    .map((r) => Number(r[field]))
    .filter((v) => Number.isFinite(v));
  if (nums.length === 0) return [];
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const counts = new Array(buckets).fill(0);
  for (const v of nums) {
    const idx = Math.min(buckets - 1, Math.floor(((v - min) / span) * buckets));
    counts[idx]++;
  }
  return counts.map((count, i) => ({
    bucket: i,
    start: min + (span / buckets) * i,
    end: min + (span / buckets) * (i + 1),
    count,
  }));
}

/** Date histogram bucketed by month. */
export function dateHistogram(
  rows: Record<string, unknown>[],
  field: string,
): { month: string; count: number }[] {
  const dates: Date[] = [];
  for (const r of rows) {
    const v = r[field];
    if (!v) continue;
    const d = new Date(String(v));
    if (!Number.isNaN(d.getTime())) dates.push(d);
  }
  const counts = new Map<string, number>();
  for (const d of dates) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort()
    .map(([month, count]) => ({ month, count }));
}

/**
 * Compose all three chart shapes for a property, given a property type.
 * The frontend exploration view calls this once per visible property.
 */
export function autoChart(
  rows: Record<string, unknown>[],
  field: string,
  baseType: string,
): {
  type: 'listogram' | 'histogram' | 'dateHistogram';
  data: any[];
  field: string;
  baseType: string;
} {
  const numeric = ['integer', 'long', 'double', 'float', 'number', 'numeric'].includes(
    baseType,
  );
  const date = ['date', 'timestamp'].includes(baseType);
  if (numeric) return { type: 'histogram', data: histogram(rows, field), field, baseType };
  if (date) return { type: 'dateHistogram', data: dateHistogram(rows, field), field, baseType };
  return { type: 'listogram', data: listogram(rows, field), field, baseType };
}
