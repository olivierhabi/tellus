import { Knex } from 'knex';
import * as fs from 'fs';
import { parse } from 'csv-parse';
import { AppError } from '@/utils/AppError';
import { DatasetListQuery } from '@/types/dataset';

export class DatasetService {
  constructor(private knex: Knex) {}

  /**
   * List datasets in a folder with pagination using COUNT(*) OVER() window function.
   */
  async listDatasets(folderId: string, query: DatasetListQuery) {
    const { status, sort, order, page, limit } = query;
    const offset = (page - 1) * limit;

    let baseQuery = this.knex('datasets')
      .select(
        'datasets.*',
        this.knex.raw('COUNT(*) OVER() AS total_count')
      )
      .where({ folder_id: folderId });

    if (status) {
      baseQuery = baseQuery.where({ status });
    }

    baseQuery = baseQuery
      .orderBy(sort, order)
      .limit(limit)
      .offset(offset);

    const rows = await baseQuery;

    const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    const totalPages = Math.ceil(totalCount / limit);

    // Remove total_count from each row
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const datasets = rows.map(({ total_count, ...rest }: Record<string, unknown>) => rest);

    return {
      datasets,
      meta: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  /**
   * Get a single dataset by ID with its columns via json_agg.
   */
  async getDatasetById(datasetId: string) {
    const rows = await this.knex.raw(
      `SELECT d.*,
        json_agg(
          json_build_object(
            'id', dc.id,
            'columnName', dc.column_name,
            'columnType', dc.column_type,
            'ordinalPosition', dc.ordinal_position,
            'nullable', dc.nullable,
            'sampleValues', dc.sample_values
          )
          ORDER BY dc.ordinal_position ASC
        ) FILTER (WHERE dc.id IS NOT NULL) AS columns
      FROM datasets d
      LEFT JOIN dataset_columns dc ON dc.dataset_id = d.id
      WHERE d.id = ?
      GROUP BY d.id`,
      [datasetId]
    );

    return rows.rows[0] || null;
  }

  /**
   * Get a preview of the dataset by reading the first N rows from the CSV file.
   */
  async getDatasetPreview(datasetId: string, rowCount: number) {
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

    // Stream-read the CSV file and collect only the requested number of rows
    const previewRows = await new Promise<Record<string, string>[]>(
      (resolve, reject) => {
        const rows: Record<string, string>[] = [];

        const ext = dataset.file_path.toLowerCase();
        const delimiter = ext.endsWith('.tsv') ? '\t' : ',';

        const parser = parse({
          delimiter,
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_column_count: true,
        });

        const readStream = fs.createReadStream(dataset.file_path);

        parser.on('readable', () => {
          let record: Record<string, string>;
          while ((record = parser.read()) !== null) {
            rows.push(record);
            if (rows.length >= rowCount) {
              parser.destroy();
              break;
            }
          }
        });

        parser.on('error', (err) => {
          readStream.destroy();
          reject(err);
        });

        parser.on('end', () => {
          resolve(rows);
        });

        parser.on('close', () => {
          if (rows.length > 0) {
            resolve(rows);
          }
        });

        readStream.pipe(parser);
      }
    );

    return {
      datasetId: dataset.id,
      name: dataset.name,
      totalRows: dataset.row_count,
      previewRowCount: previewRows.length,
      rows: previewRows,
    };
  }

  /**
   * Get lightweight dataset status info.
   */
  async getDatasetStatus(datasetId: string) {
    const dataset = await this.knex('datasets')
      .select('id', 'status', 'row_count', 'column_count')
      .where({ id: datasetId })
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    return dataset;
  }
}
