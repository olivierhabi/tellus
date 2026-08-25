import { Knex } from 'knex';
import { parse } from 'csv-parse';
import { getObjectStream } from './storageService';
import { sanitizeCsvHeader } from '../utils/csvHeader';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'stream';

const MAX_SAMPLE_ROWS = 10000;
const PREVIEW_ROWS = 10;

const NULL_INDICATORS = new Set([
  '', 'null', 'NULL', 'N/A', 'n/a', '#N/A', 'NA', 'na', 'None', 'none', '-',
]);

const BOOLEAN_VALUES = new Set([
  'true', 'false', 'TRUE', 'FALSE', 'True', 'False',
  'yes', 'no', 'YES', 'NO', 'Yes', 'No',
  '1', '0',
]);

export interface ColumnStats {
  name: string;
  inferredType: string;
  nullable: boolean;
  sampleValues: unknown[];
  min?: number;
  max?: number;
  mean?: number;
  stddev?: number;
}

export interface ParseResult {
  columns: ColumnStats[];
  rowCount: number;
  previewRows: Record<string, string>[];
  /** Byte count read from the persisted object, not the HTTP upload body. */
  fileSizeBytes: number;
  /** SHA-256 of the exact persisted object that produced this schema. */
  contentHash: string;
}

/**
 * Raised when the object in storage is not a complete, rectangular CSV/TSV.
 *
 * This is deliberately distinct from an infrastructure read failure: callers
 * can safely present this as a rejected upload and retain the original object
 * for support/audit instead of repeatedly retrying an invalid file.
 */
export class DatasetCsvValidationError extends Error {
  readonly code = 'DATASET_CSV_VALIDATION_FAILED';
  readonly cause: unknown;

  constructor(filePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Dataset file '${filePath}' is not a valid rectangular CSV/TSV: ${detail}`);
    this.name = 'DatasetCsvValidationError';
    this.cause = cause;
  }
}

class WelfordAccumulator {
  private count = 0;
  private mean_ = 0;
  private m2 = 0;
  private min_ = Infinity;
  private max_ = -Infinity;

  addValue(value: number): void {
    this.count++;
    const delta = value - this.mean_;
    this.mean_ += delta / this.count;
    const delta2 = value - this.mean_;
    this.m2 += delta * delta2;
    if (value < this.min_) this.min_ = value;
    if (value > this.max_) this.max_ = value;
  }

  getStats(): { mean: number; stddev: number; min: number; max: number } | null {
    if (this.count === 0) return null;
    return {
      mean: this.mean_,
      stddev: this.count > 1 ? Math.sqrt(this.m2 / (this.count - 1)) : 0,
      min: this.min_,
      max: this.max_,
    };
  }
}

class ColumnAccumulator {
  private booleanCount = 0;
  private integerCount = 0;
  private numericCount = 0;
  private timestampCount = 0;
  private dateCount = 0;
  private totalNonNull = 0;
  private nullCount = 0;
  private samples: unknown[] = [];
  private welford = new WelfordAccumulator();

  addValue(raw: string): void {
    if (NULL_INDICATORS.has(raw.trim())) {
      this.nullCount++;
      return;
    }
    this.totalNonNull++;
    const trimmed = raw.trim();
    if (this.samples.length < 5) {
      this.samples.push(trimmed);
    }
    if (BOOLEAN_VALUES.has(trimmed)) {
      this.booleanCount++;
    } else {
      const numVal = Number(trimmed);
      if (trimmed !== '' && !isNaN(numVal) && isFinite(numVal)) {
        this.numericCount++;
        this.welford.addValue(numVal);
        if (Number.isInteger(numVal) && !trimmed.includes('.')) {
          this.integerCount++;
        }
      }
    }
    if (isTimestamp(trimmed)) {
      this.timestampCount++;
    } else if (isDate(trimmed)) {
      this.dateCount++;
    }
  }

  inferType(): string {
    if (this.totalNonNull === 0) return 'text';
    const threshold = this.totalNonNull * 0.95;
    if (this.booleanCount >= threshold) return 'boolean';
    if (this.integerCount >= threshold) return 'integer';
    if (this.numericCount >= threshold) return 'numeric';
    if (this.timestampCount >= threshold) return 'timestamp';
    if (this.dateCount >= threshold) return 'date';
    return 'text';
  }

  getStats(): ColumnStats {
    const type = this.inferType();
    const stats: ColumnStats = {
      name: '',
      inferredType: type,
      nullable: this.nullCount > 0,
      sampleValues: this.samples,
    };
    if (type === 'integer' || type === 'numeric') {
      const numStats = this.welford.getStats();
      if (numStats) {
        stats.min = numStats.min;
        stats.max = numStats.max;
        stats.mean = numStats.mean;
        stats.stddev = numStats.stddev;
      }
    }
    return stats;
  }
}

function isTimestamp(value: string): boolean {
  const timestampPattern = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
  if (!timestampPattern.test(value)) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function isDate(value: string): boolean {
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}$/,
    /^\d{2}\/\d{2}\/\d{4}$/,
    /^\d{2}\.\d{2}\.\d{4}$/,
  ];
  if (!datePatterns.some((p) => p.test(value))) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

/**
 * Parse a CSV/TSV file from a readable stream.
 * Used internally — the public API is `parseFile` which fetches the stream from S3.
 */
function parseStream(readStream: Readable, filePath: string): Promise<ParseResult> {
  return new Promise<ParseResult>((resolve, reject) => {
    const accumulators: Map<string, ColumnAccumulator> = new Map();
    const previewRows: Record<string, string>[] = [];
    let columnNames: string[] = [];
    let rowCount = 0;
    let doneAnalyzing = false;
    let settled = false;
    let fileSizeBytes = 0;
    const contentHash = createHash('sha256');

    const ext = filePath.toLowerCase();
    const delimiter = ext.endsWith('.tsv') ? '\t' : ',';

    const parser = parse({
      delimiter,
      // `sanitizeCsvHeader` replaces csv-parse's default `columns: true`
      // behaviour. csv-parse's default collapses duplicate / empty
      // header cells (because each record becomes a JS object whose
      // keys are deduplicated), which silently drops columns from the
      // schema. The sanitizer guarantees:
      //   - one key per physical header cell (no collapse),
      //   - blanks named `column_<n>`,
      //   - duplicates suffixed `_2`, `_3`, …
      // and emits a single-line structured warning when it had to fix
      // anything (event=csv_header_sanitized) for log alerting.
      // Capture the schema from the header itself. Previously `columnNames`
      // was initialised from the first data record, which meant a valid
      // header-only CSV produced zero columns. Foundry's no-datasource object
      // type flow intentionally creates an empty permissioning dataset, so a
      // schema must not depend on the presence of user data.
      columns: (h: string[]) => {
        const names = sanitizeCsvHeader(h, { source: filePath });
        columnNames = names;
        for (const name of names) {
          accumulators.set(name, new ColumnAccumulator());
        }
        return names;
      },
      skip_empty_lines: true,
      trim: true,
      // Never relax row width during ingestion. A permissive parser turns a
      // truncated final record (or a dropped delimiter) into a seemingly
      // valid dataset whose schema and data disagree at execution time.
      // Header normalisation above handles cosmetic header defects; it does
      // not make malformed data records valid.
      relax_column_count: false,
      // UTF-8 BOM handling: strip the byte-order-mark so the first
      // column header doesn't end up as "\uFEFForder_id". Every layer
      // downstream — the client JSON body, the inputSanitizer (which
      // calls .trim(), and .trim() in V8 treats U+FEFF as whitespace),
      // and most user-facing tools — normalises BOM away. If we keep
      // it in `dataset_columns.column_name`, the column-mapping
      // validator fails to match even when the user clearly typed the
      // right name. csv-parse's `bom: true` handles this once at the
      // earliest possible point.
      bom: true,
    });

    const settle = () => {
      if (!settled) {
        settled = true;
        const columns: ColumnStats[] = columnNames.map((name) => {
          const acc = accumulators.get(name)!;
          const stats = acc.getStats();
          stats.name = name;
          return stats;
        });
        resolve({
          columns,
          rowCount,
          previewRows,
          fileSizeBytes,
          contentHash: `sha256:${contentHash.digest('hex')}`,
        });
      }
    };

    parser.on('readable', () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
        rowCount++;
        if (!doneAnalyzing) {
          if (previewRows.length < PREVIEW_ROWS) {
            previewRows.push({ ...record });
          }
          for (const col of columnNames) {
            const acc = accumulators.get(col);
            if (acc) {
              acc.addValue(record[col] ?? '');
            }
          }
          if (rowCount >= MAX_SAMPLE_ROWS) {
            doneAnalyzing = true;
          }
        }
      }
    });

    parser.on('error', (err) => {
      readStream.destroy();
      if (!settled) {
        settled = true;
        reject(new DatasetCsvValidationError(filePath, err));
      }
    });

    parser.on('end', () => {
      settle();
    });

    parser.on('close', () => {
      settle();
    });

    // Account for the exact bytes actually parsed. This proves that schema,
    // preview and row count were derived from the persisted S3 object rather
    // than from an in-memory request body that could differ from storage.
    const accountingStream = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        fileSizeBytes += bytes.length;
        contentHash.update(bytes);
        callback(null, chunk);
      },
    });

    readStream.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    accountingStream.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    readStream.pipe(accountingStream).pipe(parser);
  });
}

export class CsvParsingService {
  constructor(private knex: Knex) {}

  /**
   * Parse a file from S3/MinIO object storage.
   * @param filePath - The S3 object key (stored in foundry_datasets.file_path)
   */
  async parseFile(filePath: string): Promise<ParseResult> {
    const readStream = await getObjectStream(filePath);
    return parseStream(readStream, filePath);
  }

  /**
   * Parse a file from a readable stream (for preview purposes).
   */
  async parseFromStream(readStream: Readable, filePath: string): Promise<ParseResult> {
    return parseStream(readStream, filePath);
  }
}

// Export singleton
import foundryDb from '../config/foundryDb';

export const csvParsingService = new CsvParsingService(foundryDb);
