import { Knex } from 'knex';
import * as fs from 'fs';
import { parse } from 'csv-parse';
import { AppError } from '@/utils/AppError';

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'isNull'
  | 'isNotNull';

export interface FilterCondition {
  column: string;
  operator: FilterOperator;
  value?: string;
}

export interface SortCondition {
  column: string;
  direction: 'asc' | 'desc';
}

export type SampleMode = 'first' | 'random' | 'last';

export interface AdvancedPreviewOptions {
  columns?: string[];
  sampleMode?: SampleMode;
  sampleSize?: number;
  sort?: SortCondition[];
  filters?: FilterCondition[];
}

export interface AdvancedPreviewResult {
  datasetId: string;
  name: string;
  totalRows: number;
  returnedRows: number;
  sampleMode: SampleMode;
  columns: string[];
  rows: Record<string, string>[];
}

export class AdvancedPreviewService {
  constructor(private knex: Knex) {}

  /**
   * Get an advanced preview of dataset rows with filtering, sorting, and sampling.
   */
  async getAdvancedPreview(
    datasetId: string,
    options: AdvancedPreviewOptions
  ): Promise<AdvancedPreviewResult> {
    const {
      columns,
      sampleMode = 'first',
      sampleSize = 50,
      sort,
      filters,
    } = options;

    // Verify dataset exists and is ready
    const dataset = await this.knex('datasets')
      .where({ id: datasetId })
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    if (dataset.status !== 'ready') {
      throw new AppError(
        `Dataset is not ready for preview. Current status: ${dataset.status}`,
        400,
        'DATASET_NOT_READY'
      );
    }

    // Read all rows from the CSV file
    const allRows = await this.readCsvFile(dataset.file_path);

    if (allRows.length === 0) {
      return {
        datasetId: dataset.id,
        name: dataset.name,
        totalRows: 0,
        returnedRows: 0,
        sampleMode,
        columns: columns || [],
        rows: [],
      };
    }

    // Determine available columns from the first row
    const availableColumns = Object.keys(allRows[0]);

    // Validate requested columns
    const selectedColumns = columns && columns.length > 0
      ? columns.filter((c) => availableColumns.includes(c))
      : availableColumns;

    if (columns && columns.length > 0 && selectedColumns.length === 0) {
      throw new AppError(
        'None of the requested columns exist in the dataset',
        400,
        'INVALID_COLUMNS'
      );
    }

    // Step 1: Apply filters
    let filteredRows = allRows;
    if (filters && filters.length > 0) {
      filteredRows = this.applyFilters(filteredRows, filters);
    }

    // Step 2: Apply sorting
    if (sort && sort.length > 0) {
      filteredRows = this.applySort(filteredRows, sort);
    }

    // Step 3: Apply sampling
    const sampledRows = this.applySample(filteredRows, sampleMode, sampleSize);

    // Step 4: Select columns
    const projectedRows = sampledRows.map((row) => {
      const projected: Record<string, string> = {};
      for (const col of selectedColumns) {
        projected[col] = row[col] ?? '';
      }
      return projected;
    });

    return {
      datasetId: dataset.id,
      name: dataset.name,
      totalRows: dataset.row_count ?? allRows.length,
      returnedRows: projectedRows.length,
      sampleMode,
      columns: selectedColumns,
      rows: projectedRows,
    };
  }

  /**
   * Read all rows from a CSV/TSV file.
   */
  private readCsvFile(filePath: string): Promise<Record<string, string>[]> {
    return new Promise((resolve, reject) => {
      const rows: Record<string, string>[] = [];

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

      parser.on('readable', () => {
        let record: Record<string, string>;
        while ((record = parser.read()) !== null) {
          rows.push(record);
        }
      });

      parser.on('error', (err) => {
        readStream.destroy();
        reject(err);
      });

      parser.on('end', () => {
        resolve(rows);
      });

      readStream.pipe(parser);
    });
  }

  /**
   * Apply filter conditions to rows.
   */
  private applyFilters(
    rows: Record<string, string>[],
    filters: FilterCondition[]
  ): Record<string, string>[] {
    return rows.filter((row) => {
      return filters.every((filter) => {
        const cellValue = row[filter.column];
        return this.evaluateFilter(cellValue, filter.operator, filter.value);
      });
    });
  }

  /**
   * Evaluate a single filter condition against a cell value.
   */
  private evaluateFilter(
    cellValue: string | undefined,
    operator: FilterOperator,
    filterValue?: string
  ): boolean {
    switch (operator) {
      case 'isNull':
        return cellValue === undefined || cellValue === null || cellValue.trim() === '';

      case 'isNotNull':
        return cellValue !== undefined && cellValue !== null && cellValue.trim() !== '';

      case 'eq':
        return cellValue === filterValue;

      case 'neq':
        return cellValue !== filterValue;

      case 'contains':
        return cellValue !== undefined &&
          filterValue !== undefined &&
          cellValue.toLowerCase().includes(filterValue.toLowerCase());

      case 'gt': {
        const numCell = Number(cellValue);
        const numFilter = Number(filterValue);
        if (isNaN(numCell) || isNaN(numFilter)) return cellValue! > filterValue!;
        return numCell > numFilter;
      }

      case 'lt': {
        const numCell = Number(cellValue);
        const numFilter = Number(filterValue);
        if (isNaN(numCell) || isNaN(numFilter)) return cellValue! < filterValue!;
        return numCell < numFilter;
      }

      case 'gte': {
        const numCell = Number(cellValue);
        const numFilter = Number(filterValue);
        if (isNaN(numCell) || isNaN(numFilter)) return cellValue! >= filterValue!;
        return numCell >= numFilter;
      }

      case 'lte': {
        const numCell = Number(cellValue);
        const numFilter = Number(filterValue);
        if (isNaN(numCell) || isNaN(numFilter)) return cellValue! <= filterValue!;
        return numCell <= numFilter;
      }

      default:
        return true;
    }
  }

  /**
   * Apply sort conditions to rows.
   */
  private applySort(
    rows: Record<string, string>[],
    sort: SortCondition[]
  ): Record<string, string>[] {
    return [...rows].sort((a, b) => {
      for (const condition of sort) {
        const aVal = a[condition.column] ?? '';
        const bVal = b[condition.column] ?? '';

        // Try numeric comparison first
        const aNum = Number(aVal);
        const bNum = Number(bVal);

        let comparison: number;
        if (!isNaN(aNum) && !isNaN(bNum)) {
          comparison = aNum - bNum;
        } else {
          comparison = aVal.localeCompare(bVal);
        }

        if (comparison !== 0) {
          return condition.direction === 'desc' ? -comparison : comparison;
        }
      }
      return 0;
    });
  }

  /**
   * Apply sampling mode to rows.
   */
  private applySample(
    rows: Record<string, string>[],
    mode: SampleMode,
    size: number
  ): Record<string, string>[] {
    const clampedSize = Math.min(size, rows.length);

    switch (mode) {
      case 'first':
        return rows.slice(0, clampedSize);

      case 'last':
        return rows.slice(-clampedSize);

      case 'random': {
        // Fisher-Yates shuffle on a copy, then take first N
        const shuffled = [...rows];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled.slice(0, clampedSize);
      }

      default:
        return rows.slice(0, clampedSize);
    }
  }
}
