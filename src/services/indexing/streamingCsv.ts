import { parse } from "csv-parse";
import type { Readable } from "stream";
import { sanitizeCsvHeader } from "../../utils/csvHeader";

// ---------------------------------------------------------------------------
// streamingCsv.ts
//
// Stream a Readable (an S3 object body from `getObjectStream`, or a disk
// `fs.createReadStream`) through `csv-parse`, yielding one sanitized row
// object at a time via an async generator.
//
// Why this exists: the legacy readers (`reindexService.readFoundryBridgedFile`
// and `readCsvFile`, plus `dataPreview`'s preview path) materialized the
// ENTIRE backing file in memory before parsing:
//
//     const buffer = await getObjectBuffer(key);  // whole file -> one Buffer
//     const content = buffer.toString("utf-8");    // whole file -> one string
//     const records = parse(content, ...);         // whole file -> one array
//
// For an 854 MB / 5.6 M-row CSV that hits two hard walls:
//   - `buffer.toString("utf-8")` exceeds `Buffer.constants.MAX_STRING_LENGTH`
//     (512 MiB) and throws "Cannot create a string longer than 0x1fffffe8
//     characters" — which surfaces as a failed reindex stuck at the
//     changelog/merge stage.
//   - Downloading the whole object + collecting every row just to slice the
//     first 50 for a preview blows the 5 s request budget and 504s.
//
// This helper never holds more than csv-parse's internal high-water-mark
// buffer of records in memory, so it scales to files far larger than the
// string limit. `maxRows` stops (and tears down the upstream download)
// after N data rows — a 50-row preview of an 854 MB file streams ~50 rows
// and bails instead of pulling the whole object.
// ---------------------------------------------------------------------------

export interface ParseCsvReadableOptions {
  /** CSV delimiter. Default `,` (pass `"\t"` for TSV). */
  delimiter?: string;
  /**
   * Human-readable identifier for the stream (S3 key, path, dataset id).
   * Forwarded to `sanitizeCsvHeader` so its warning log can trace the file.
   */
  source?: string;
  /** Stop and tear down both streams after this many DATA rows. `null` = unlimited. */
  maxRows?: number | null;
  /**
   * When true, normalize empty / null-like cells (`""`, `null`, `na`, `n/a`)
   * to JS `null` — matching the legacy `reindexService` reader semantics so
   * `convertValue` treats blanks as SQL NULL. Previews pass `false` to keep
   * raw strings for column-stat detection.
   */
  normalizeNulls?: boolean;
}

export interface StreamingCsv {
  /**
   * Async generator yielding one row object per data record, keyed by the
   * sanitized header. The sanitized header itself is recoverable as
   * `Object.keys(firstRow)`; for a header-only file the generator yields
   * nothing.
   */
  rows: AsyncGenerator<Record<string, string | null>, void, unknown>;
}

/**
 * Parse a CSV/TSV `Readable` into a streaming async generator of row
 * objects. The first record is consumed as the header (sanitized via
 * `sanitizeCsvHeader` so duplicate / blank header cells don't silently
 * collapse columns); subsequent records are yielded as objects keyed by
 * those sanitized names.
 */
export async function parseCsvReadable(
  readable: Readable,
  opts: ParseCsvReadableOptions = {},
): Promise<StreamingCsv> {
  const delimiter = opts.delimiter ?? ",";
  const source = opts.source ?? "stream";
  const maxRows = opts.maxRows ?? null;
  const normalizeNulls = opts.normalizeNulls ?? false;

  const parser = parse({
    delimiter,
    quote: '"',
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
    // `columns` as a callback: csv-parse hands it the raw header array and
    // uses whatever it returns as the object key set for EVERY record. We
    // strip a UTF-8 BOM off the first cell (the S3/disk bodies arrive as raw
    // bytes; csv-parse doesn't guarantee BOM stripping for this callback)
    // then run the shared sanitizer (no silent column collapse).
    columns: (h: string[]) => {
      if (h.length && h[0].charCodeAt(0) === 0xfeff) {
        h[0] = h[0].slice(1);
      }
      return sanitizeCsvHeader(h, { source });
    },
  });

  async function* gen(): AsyncGenerator<Record<string, string | null>, void, unknown> {
    let count = 0;
    // Wire the pipe LAZILY — only when the generator is first driven — so a
    // caller that obtains `{rows}` but never iterates it doesn't kick off an
    // S3 GET / disk read that nothing will tear down. (Eager piping +
    // lazy-finally teardown was a resource-lifecycle mismatch: the pipe
    // began consuming immediately while destroy() was deferred to the
    // generator's finally, which only fires if the generator is driven.)
    const onUpstreamError = (err: Error) => {
      parser.destroy(err);
    };
    readable.on("error", onUpstreamError);
    readable.pipe(parser);
    try {
      // Native async iteration of the parser: Node's stream async-iteration
      // protocol drains `parser.read()` with proper backpressure (bounded by
      // the stream's high-water mark), so memory stays flat regardless of
      // file size. A consumer `break` (or a `maxRows` early return) triggers
      // the `finally`, which destroys both ends and cancels the upstream
      // download mid-flight.
      for await (const record of parser as AsyncIterable<
        Record<string, string | null>
      >) {
        if (normalizeNulls) {
          for (const k of Object.keys(record)) {
            const v = record[k];
            if (typeof v === "string") {
              const n = v.trim().toLowerCase();
              if (n === "" || n === "null" || n === "na" || n === "n/a") {
                record[k] = null;
              }
            }
          }
        }
        yield record;
        count++;
        if (maxRows !== null && count >= maxRows) {
          return;
        }
      }
    } finally {
      // Cancel the upstream download (S3 GET) + the parser. Without this,
      // a 50-row preview would keep pulling an 854 MB object to completion.
      readable.off("error", onUpstreamError);
      readable.destroy();
      parser.destroy();
    }
  }

  return { rows: gen() };
}
