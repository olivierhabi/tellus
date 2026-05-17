/**
 * csvHeader — production-grade CSV header sanitizer.
 *
 * Background
 * ----------
 * `csv-parse` with `columns: true` builds each record as an object keyed by
 * the header row. JavaScript object keys are unique, so:
 *
 *   - Two header cells with the **same** name collapse into one key
 *     (the second overwrites the first).
 *   - Two **empty** header cells collapse into a single `""` key.
 *   - A `BOM` byte on the first cell silently differentiates it
 *     from later cells (`\uFEFForder_id` ≠ `order_id`).
 *
 * Combined with `relax_column_count: true`, the parser then silently drops
 * the surplus data fields and persists a corrupted schema (fewer columns
 * than the file actually contains). This module makes the header sane
 * **before** csv-parse sees it, by giving:
 *
 *   - blank cells a positional fallback name (`column_<n>`),
 *   - duplicate cells numeric suffixes (`amount`, `amount_2`, …),
 *   - every cell a BOM-stripped, trimmed surface form.
 *
 * It also emits a structured warning to stderr (one line per sanitized
 * file) so silent schema corruption is observable in production logs.
 *
 * This is used as the `columns` option of every `csv-parse` call site in
 * the codebase. See `git grep -n "sanitizeCsvHeader"` for callers.
 *
 *   parse({
 *     columns: (header) => sanitizeCsvHeader(header, { source: filePath }),
 *     ...
 *   })
 *
 * The callback shape matches the csv-parse v5 contract: it receives the
 * raw header row as `string[]` and must return the resolved column names
 * as `string[]`.
 */

export interface SanitizeCsvHeaderOptions {
  /**
   * A human-readable identifier for the file/stream being parsed
   * (S3 key, local path, dataset id, etc.). Included in the warning
   * log when sanitization mutates any names, so the responsible file
   * can be traced from log aggregation. Optional — when omitted, the
   * log line uses `<unknown>`.
   */
  source?: string;

  /**
   * Inject an alternative logger for tests. Defaults to `console.warn`.
   * The function is invoked at most once per call to `sanitizeCsvHeader`
   * with a single structured-log line.
   */
  log?: (line: string) => void;
}

/**
 * Sanitize a CSV header row.
 *
 * Guarantees on the returned array:
 *   - length === input.length (no columns silently dropped)
 *   - every entry is a non-empty string
 *   - every entry is unique
 *
 * @param header Raw header cells as csv-parse delivered them.
 * @param opts   Optional context (source path, logger override).
 */
export function sanitizeCsvHeader(
  header: readonly string[],
  opts: SanitizeCsvHeaderOptions = {},
): string[] {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const source = opts.source ?? '<unknown>';

  // First pass — strip BOM + zero-width chars, trim, substitute blanks
  // with a positional fallback.
  const filledBlanks: number[] = [];
  const base: string[] = header.map((cell, idx) => {
    const cleaned = stripZeroWidth(cell ?? '').trim();
    if (cleaned === '') {
      filledBlanks.push(idx + 1);
      return `column_${idx + 1}`;
    }
    return cleaned;
  });

  // Second pass — disambiguate duplicates with a numeric suffix.
  // We pick the first occurrence as the canonical name and rename
  // subsequent collisions (`name`, `name_2`, `name_3`, …). The chosen
  // suffix must itself not collide with a name already in the header,
  // so we increment until we find a free slot.
  const counts = new Map<string, number>();
  const taken = new Set<string>(base);
  const renamed: Array<{ original: string; renamed: string; ordinal: number }> =
    [];
  const out: string[] = base.map((name, idx) => {
    const seen = counts.get(name) ?? 0;
    counts.set(name, seen + 1);
    if (seen === 0) return name;

    // Find the lowest suffix that doesn't collide with another header cell
    // (or with a previously-resolved suffix from this same loop).
    let suffix = seen + 1;
    let candidate = `${name}_${suffix}`;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `${name}_${suffix}`;
    }
    taken.add(candidate);
    renamed.push({ original: name, renamed: candidate, ordinal: idx + 1 });
    return candidate;
  });

  if (filledBlanks.length > 0 || renamed.length > 0) {
    // Single-line JSON-ish warning so log scrapers (Loki/Datadog) can
    // dedupe and alert on it. Keep the surface stable — runbooks key off
    // the `event=csv_header_sanitized` token.
    const payload = {
      event: 'csv_header_sanitized',
      source,
      header_length: header.length,
      filled_blanks_at: filledBlanks,
      renamed_duplicates: renamed,
    };
    log(`[csvHeader] ${JSON.stringify(payload)}`);
  }

  return out;
}

/**
 * Strip leading/embedded BOM (U+FEFF) and other zero-width characters
 * that survive `.trim()` in some Node versions.
 *
 * Exported for re-use by call sites that already strip BOM on the row
 * keys (e.g. `transformService.stripBom`) — keeping a single definition
 * here prevents drift.
 */
export function stripZeroWidth(s: string): string {
  return s.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '');
}
