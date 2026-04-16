// ---------------------------------------------------------------------------
// csvExport.ts — RFC 4180 CSV writer with UTF-8 BOM
// ---------------------------------------------------------------------------
// Spec §Task 27:
//   "CSV uses RFC 4180 with BOM for Excel compatibility. Max export:
//    1M rows. Streaming — never load full dataset in memory."
//
// Escaping rules (RFC 4180 §2):
//   - Fields containing commas, double-quotes, CR, or LF must be enclosed
//     in double-quotes.
//   - A double-quote inside a quoted field must be escaped as two
//     double-quotes ("").
//   - The BOM (0xEF 0xBB 0xBF) is written at the very top so Excel
//     auto-detects UTF-8.
// ---------------------------------------------------------------------------

import { Writable } from "stream";

export const MAX_EXPORT_ROWS = 1_000_000;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NEEDS_QUOTING = /[",\r\n]/;

/** Escape a single CSV field per RFC 4180. */
export function escapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (NEEDS_QUOTING.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build a single CSV row from an array of field values. */
export function encodeRow(values: unknown[]): string {
  return values.map(escapeField).join(",") + "\r\n";
}

/**
 * Stream rows to a writable destination. Rows are supplied via an async
 * iterable so the caller can pump pages from Elasticsearch / Postgres
 * without materializing the full dataset.
 */
export async function writeCsv(
  rows: AsyncIterable<Record<string, unknown>>,
  columns: string[],
  dest: Writable
): Promise<{ rowCount: number; truncated: boolean }> {
  dest.write(BOM);
  dest.write(encodeRow(columns));

  let count = 0;
  let truncated = false;
  for await (const row of rows) {
    if (count >= MAX_EXPORT_ROWS) {
      truncated = true;
      break;
    }
    dest.write(encodeRow(columns.map((c) => row[c] ?? null)));
    count++;
  }
  dest.end();
  return { rowCount: count, truncated };
}

/**
 * Convenience: collect an iterable into a single Buffer. For small
 * exports (< 100k rows). Larger jobs should stream to a file instead.
 */
export async function csvToBuffer(
  rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
  columns: string[]
): Promise<Buffer> {
  const chunks: Buffer[] = [BOM, Buffer.from(encodeRow(columns), "utf8")];
  let count = 0;
  for await (const row of rows as AsyncIterable<Record<string, unknown>>) {
    if (count >= MAX_EXPORT_ROWS) break;
    chunks.push(Buffer.from(encodeRow(columns.map((c) => row[c] ?? null)), "utf8"));
    count++;
  }
  return Buffer.concat(chunks);
}
