import { Knex } from 'knex';
import * as fs from 'fs';
import { parse } from 'csv-parse';

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
    }
    const numVal = Number(trimmed);
    if (trimmed !== '' && !isNaN(numVal) && isFinite(numVal)) {
      this.numericCount++;
      this.welford.addValue(numVal);
      if (Number.isInteger(numVal) && !trimmed.includes('.')) {
        this.integerCount++;
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

export class CsvParsingService {
  constructor(private knex: Knex) {}

  async parseFile(filePath: string): Promise<ParseResult> {
    return new Promise<ParseResult>((resolve, reject) => {
      const accumulators: Map<string, ColumnAccumulator> = new Map();
      const previewRows: Record<string, string>[] = [];
      let columnNames: string[] = [];
      let rowCount = 0;
      let settled = false;

      const ext = filePath.toLowerCase();
      const delimiter = ext.endsWith('.tsv') ? '\t' : ',';

      const parser = parse({
        delimiter,
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      const readStream = fs.createReadStream(filePath);

      const settle = () => {
        if (!settled) {
          settled = true;
          const columns: ColumnStats[] = columnNames.map((name) => {
            const acc = accumulators.get(name)!;
            const stats = acc.getStats();
            stats.name = name;
            return stats;
          });
          resolve({ columns, rowCount, previewRows });
        }
      };

      parser.on('readable', () => {
        let record: Record<string, string>;
        while ((record = parser.read()) !== null) {
          rowCount++;
          if (columnNames.length === 0) {
            columnNames = Object.keys(record);
            for (const col of columnNames) {
              accumulators.set(col, new ColumnAccumulator());
            }
          }
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
            parser.destroy();
            break;
          }
        }
      });

      parser.on('error', (err) => {
        readStream.destroy();
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      parser.on('end', () => {
        settle();
      });

      parser.on('close', () => {
        settle();
      });

      readStream.pipe(parser);
    });
  }
}

// Export singleton
import foundryDb from '../config/foundryDb';

export const csvParsingService = new CsvParsingService(foundryDb);
