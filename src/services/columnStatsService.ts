import { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';

export interface ColumnStats {
  columnName: string;
  columnType: string;
  ordinalPosition: number;
  nullable: boolean;
  sampleValues: unknown[];
  distinctCount: number | null;
  nullCount: number | null;
  min: unknown | null;
  max: unknown | null;
  mean: number | null;
  stddev: number | null;
}

export interface DatasetProfile {
  datasetId: string;
  name: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnStats[];
  profileGeneratedAt: string;
}

export class ColumnStatsService {
  constructor(private knex: Knex) {}

  async getColumnStats(datasetId: string, columnName: string): Promise<ColumnStats> {
    const dataset = await this.knex('foundry_datasets')
      .where({ id: datasetId })
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    if (dataset.status !== 'ready') {
      throw new AppError(
        `Dataset is not ready for profiling. Current status: ${dataset.status}`,
        400,
        'DATASET_NOT_READY'
      );
    }

    const column = await this.knex('dataset_columns')
      .where({ dataset_id: datasetId, column_name: columnName })
      .first();

    if (!column) {
      throw new AppError(
        `Column "${columnName}" not found in dataset`,
        404,
        'COLUMN_NOT_FOUND'
      );
    }

    const sampleValues = column.sample_values || {};

    return {
      columnName: column.column_name,
      columnType: column.column_type,
      ordinalPosition: column.ordinal_position,
      nullable: column.nullable,
      sampleValues: sampleValues.values || [],
      distinctCount: sampleValues.distinctCount ?? null,
      nullCount: sampleValues.nullCount ?? null,
      min: sampleValues.min ?? null,
      max: sampleValues.max ?? null,
      mean: sampleValues.mean ?? null,
      stddev: sampleValues.stddev ?? null,
    };
  }

  async getDatasetProfile(datasetId: string): Promise<DatasetProfile> {
    const dataset = await this.knex('foundry_datasets')
      .where({ id: datasetId })
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    if (dataset.status !== 'ready') {
      throw new AppError(
        `Dataset is not ready for profiling. Current status: ${dataset.status}`,
        400,
        'DATASET_NOT_READY'
      );
    }

    const columns = await this.knex('dataset_columns')
      .where({ dataset_id: datasetId })
      .orderBy('ordinal_position', 'asc');

    const columnStats: ColumnStats[] = columns.map((col: Record<string, unknown>) => {
      const sampleValues = (col.sample_values as Record<string, unknown>) || {};
      return {
        columnName: col.column_name as string,
        columnType: col.column_type as string,
        ordinalPosition: col.ordinal_position as number,
        nullable: col.nullable as boolean,
        sampleValues: (sampleValues.values as unknown[]) || [],
        distinctCount: (sampleValues.distinctCount as number) ?? null,
        nullCount: (sampleValues.nullCount as number) ?? null,
        min: sampleValues.min ?? null,
        max: sampleValues.max ?? null,
        mean: (sampleValues.mean as number) ?? null,
        stddev: (sampleValues.stddev as number) ?? null,
      };
    });

    return {
      datasetId: dataset.id,
      name: dataset.name,
      rowCount: dataset.row_count ?? 0,
      columnCount: dataset.column_count ?? columns.length,
      columns: columnStats,
      profileGeneratedAt: new Date().toISOString(),
    };
  }
}
