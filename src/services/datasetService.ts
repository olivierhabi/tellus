import { Knex } from 'knex';
import { parse } from 'csv-parse';
import { AppError, NotFoundError, ConflictError } from '../utils/foundryAppError';
import { DatasetListQuery } from '../types/dataset';
import { getObjectStream } from './storageService';

export class DatasetService {
  constructor(private knex: Knex) {}

  /**
   * List datasets at the project root level (folder_id IS NULL).
   */
  async listProjectRootDatasets(projectId: string): Promise<Record<string, unknown>[]> {
    return this.knex('foundry_datasets')
      .where({ project_id: projectId })
      .whereNull('folder_id')
      .orderBy('name', 'asc');
  }

  /**
   * List ALL datasets belonging to a project — across every folder and
   * the project root. Used by the pipeline builder's "Add Foundry data"
   * dialog to show every available dataset for selection.
   *
   * The query uses a LEFT JOIN on folders because datasets can live at the
   * project root (folder_id IS NULL, project_id set directly) or inside a
   * folder (folder_id references folders which has project_id).
   */
  async listAllProjectDatasets(projectId: string): Promise<Record<string, unknown>[]> {
    return this.knex('foundry_datasets as d')
      .leftJoin('folders as f', 'd.folder_id', 'f.id')
      .where(function () {
        this.where('f.project_id', projectId)
          .orWhere('d.project_id', projectId);
      })
      .select(
        'd.id',
        'd.name',
        'd.status',
        'd.file_size_bytes',
        'd.row_count',
        'd.column_count',
        'd.original_filename',
        'd.mime_type',
        'd.created_at',
        'd.updated_at',
      )
      .orderBy('d.name', 'asc');
  }

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
            'name', dc.column_name,
            'type', dc.column_type,
            'ordinal_position', dc.ordinal_position,
            'nullable', dc.nullable,
            'sample_values', COALESCE(dc.sample_values, '[]'::jsonb)
          )
          ORDER BY dc.ordinal_position ASC
        ) FILTER (WHERE dc.id IS NOT NULL) AS columns,
        uc.display_name AS created_by_display_name,
        uu.display_name AS updated_by_display_name
      FROM foundry_datasets d
      LEFT JOIN dataset_columns dc ON dc.dataset_id = d.id
      LEFT JOIN users uc ON uc.id = d.created_by
      LEFT JOIN users uu ON uu.id = d.updated_by
      WHERE d.id = ?
      GROUP BY d.id, uc.display_name, uu.display_name`,
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

    // Fetch the S3 stream before entering the Promise constructor
    const readStream = await getObjectStream(dataset.file_path);

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

  async updateDataset(datasetId: string, updates: { name?: string; folderId?: string }, userId?: string): Promise<any> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw NotFoundError('Dataset not found');

    const updateData: any = { updated_at: new Date(), updated_by: userId ?? null };
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

  async duplicateDataset(datasetId: string, userId?: string): Promise<any> {
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
      created_by: userId ?? null,
      updated_by: userId ?? null,
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
