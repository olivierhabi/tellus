import { Knex } from 'knex';
import * as fs from 'fs';
import { parse } from 'csv-parse';
import { AppError, NotFoundError, ConflictError } from '../utils/foundryAppError';
import { DatasetListQuery } from '../types/dataset';

export class DatasetService {
  constructor(private knex: Knex) {}

  async listDatasets(folderId: string, query: DatasetListQuery) {
    const { status, sort, order, page, limit } = query;
    const offset = (page - 1) * limit;

    let baseQuery = this.knex('foundry_datasets')
      .select(
        'foundry_datasets.*',
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
      FROM foundry_datasets d
      LEFT JOIN dataset_columns dc ON dc.dataset_id = d.id
      WHERE d.id = ?
      GROUP BY d.id`,
      [datasetId]
    );

    return rows.rows[0] || null;
  }

  async getDatasetPreview(datasetId: string, rowCount: number) {
    const dataset = await this.knex('foundry_datasets')
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

    const previewRows = await new Promise<Record<string, string>[]>(
      (resolve, reject) => {
        const rows: Record<string, string>[] = [];
        let settled = false;
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

        const settle = () => {
          if (!settled) {
            settled = true;
            resolve(rows);
          }
        };

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
          if (!settled) {
            settled = true;
            reject(err);
          }
        });

        parser.on('end', () => {
          settle();
        });

        // 'close' fires after destroy(); 'end' fires on normal completion.
        // The settle() guard ensures resolve is only called once regardless
        // of which event fires first.
        parser.on('close', () => {
          settle();
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

  async getDatasetStatus(datasetId: string) {
    const dataset = await this.knex('foundry_datasets')
      .select('id', 'status', 'row_count', 'column_count', 'updated_at')
      .where({ id: datasetId })
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    return dataset;
  }

  async getDatasetStatusBatch(ids: string[]) {
    const rows = await this.knex('foundry_datasets')
      .select('id', 'status', 'updated_at')
      .whereIn('id', ids);
    return rows.map((r: any) => ({
      id: r.id,
      status: r.status,
      updatedAt: r.updated_at,
    }));
  }

  async getDatasetSummary(datasetId: string) {
    const dataset = await this.knex('foundry_datasets')
      .select('id', 'file_size_bytes', 'row_count', 'column_count', 'status', 'original_filename', 'mime_type', 'created_at', 'updated_at')
      .where({ id: datasetId })
      .first();
    if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    return {
      datasetId: dataset.id,
      fileSize: Number(dataset.file_size_bytes) || 0,
      rowCount: dataset.row_count != null ? Number(dataset.row_count) : null,
      columnCount: dataset.column_count != null ? Number(dataset.column_count) : null,
      parsedAt: dataset.updated_at && dataset.status === 'ready' ? new Date(dataset.updated_at).toISOString() : null,
      status: dataset.status,
      originalFilename: dataset.original_filename,
      mimeType: dataset.mime_type,
    };
  }

  async updateDataset(datasetId: string, updates: { name?: string; folderId?: string }): Promise<any> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw NotFoundError('Dataset not found');

    const updateData: any = { updated_at: new Date() };
    if (updates.name !== undefined) {
      // Check for duplicate name in same folder
      const existing = await this.knex('foundry_datasets')
        .where({ folder_id: updates.folderId ?? dataset.folder_id, name: updates.name })
        .whereNot({ id: datasetId })
        .first();
      if (existing) throw ConflictError('A dataset with this name already exists in this folder');
      updateData.name = updates.name;
    }
    if (updates.folderId !== undefined) {
      updateData.folder_id = updates.folderId;
    }

    const [updated] = await this.knex('foundry_datasets').where({ id: datasetId }).update(updateData).returning('*');
    return updated;
  }

  async deleteDataset(datasetId: string): Promise<void> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw NotFoundError('Dataset not found');

    // Delete columns first (FK)
    await this.knex('dataset_columns').where({ dataset_id: datasetId }).delete();
    // Delete versions
    await this.knex('dataset_versions').where({ dataset_id: datasetId }).delete();
    // Delete dataset
    await this.knex('foundry_datasets').where({ id: datasetId }).delete();
  }

  async duplicateDataset(datasetId: string): Promise<any> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw NotFoundError('Dataset not found');

    const newName = dataset.name.replace(/(\.[^.]+)$/, ' (copy)$1');
    const [dup] = await this.knex('foundry_datasets').insert({
      name: newName,
      folder_id: dataset.folder_id,
      file_path: dataset.file_path,
      original_filename: dataset.original_filename,
      mime_type: dataset.mime_type,
      file_size_bytes: dataset.file_size_bytes,
      row_count: dataset.row_count,
      column_count: dataset.column_count,
      schema_info: dataset.schema_info ? JSON.stringify(dataset.schema_info) : null,
      status: dataset.status,
      content_hash: dataset.content_hash,
    }).returning('*');

    // Copy columns
    const columns = await this.knex('dataset_columns').where({ dataset_id: datasetId });
    if (columns.length > 0) {
      await this.knex('dataset_columns').insert(columns.map((c: any) => ({
        dataset_id: dup.id,
        column_name: c.column_name,
        column_type: c.column_type,
        ordinal_position: c.ordinal_position,
        nullable: c.nullable,
        sample_values: JSON.stringify(c.sample_values ?? []),
      })));
    }

    return dup;
  }
}
