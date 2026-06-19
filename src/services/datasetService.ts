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

  /**
   * Delete a dataset.
   *
   * Production semantics: BEFORE the hard-delete, mirror the dataset
   * (plus its columns and versions) into the `resources` table with
   * `trash_status = 'DIRECTLY_TRASHED'`. This keeps the dataset visible
   * in the project Trash page (`/projects/<id>/trash`) and lets the user
   * restore from snapshot or permanently delete via the standard
   * resource lifecycle endpoints.
   *
   * The whole flow runs in a single knex transaction so the mirror and
   * the hard-delete are atomic — partial failure rolls everything back
   * and leaves the dataset live.
   *
   * @param datasetId UUID of the dataset
   * @param actorId   UUID of the user performing the delete (for trashed_by audit)
   */
  async deleteDataset(datasetId: string, actorId?: string): Promise<void> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw NotFoundError('Dataset not found');

    // Snapshot the related rows BEFORE the transaction so we can build
    // the metadata payload. (Reads outside the txn are fine — we hold
    // no row locks yet.)
    const columns = await this.knex('dataset_columns').where({ dataset_id: datasetId });
    const versions = await this.knex('dataset_versions').where({ dataset_id: datasetId });

    // ---------------------------------------------------------------
    // Resolve the parent project. Datasets created via the upload flow
    // store `project_id` directly on the row, but datasets nested in a
    // folder (or rows produced by older code paths such as a
    // `duplicateDataset` that did not propagate `project_id`) may have
    // `project_id = NULL`. Derive from `folders.project_id` in that
    // case so we always have a real project ancestor for the resource
    // mirror — without this, the INSERT into `resources` below fails
    // with a 23503 FK violation (resources.project_rid → resources.rid
    // is RESTRICT) and the whole deletion rolls back.
    // ---------------------------------------------------------------
    let resolvedProjectId: string | null = (dataset.project_id as string | null) ?? null;
    if (!resolvedProjectId && dataset.folder_id) {
      const folder = await this.knex('folders')
        .where({ id: dataset.folder_id })
        .first('project_id') as { project_id?: string } | undefined;
      resolvedProjectId = folder?.project_id ?? null;
    }
    if (!resolvedProjectId) {
      // No way to anchor the resource mirror — refuse rather than
      // produce a 23503 surfaced as a generic validation error.
      throw new AppError(
        'Dataset cannot be deleted: missing parent project. Contact an administrator.',
        409,
        'RESOURCE_ORPHANED',
      );
    }

    // Foundry-faithful Compass identifiers.
    // - Dataset rids use the `foundry-dataset` service segment (hyphenated).
    // - Folder rids in `resources` use `compass-folder` (NOT `folder`) —
    //   verified empirically: `SELECT DISTINCT split_part(parent_folder_rid,'.',4)`
    //   over `resources` returns only `compass-folder` and `project`.
    // - Project rids are `project`.
    // - Space rid is fixed.
    const canonicalDatasetRid = `ri.compass.main.foundry-dataset.${datasetId}`;
    const existingRow = await this.knex('resources')
      .where('legacy_uuid', datasetId)
      .first('rid') as { rid: string } | undefined;
    const datasetRid = existingRow?.rid ?? canonicalDatasetRid;
    const projectRid = `ri.compass.main.project.${resolvedProjectId}`;

    // resources.parent_folder_rid is RESTRICT-FK to resources.rid. We
    // try the folder's `compass-folder` rid first; if that row is not
    // registered, fall back to the project rid (which we just verified
    // upstream). Both branches must point at a row that actually exists.
    const parentFolderRid: string = await (async () => {
      if (!dataset.folder_id) return projectRid;
      const folderRid = `ri.compass.main.compass-folder.${dataset.folder_id}`;
      const exists = await this.knex.raw(
        'SELECT 1 FROM resources WHERE rid = ?',
        [folderRid],
      );
      const has = ((exists as { rows?: unknown[] }).rows ?? []).length > 0;
      return has ? folderRid : projectRid;
    })();

    // Verify the project resource row exists; if it does not, fail
    // cleanly. (We do NOT auto-create it here — that's the
    // responsibility of the project creation path; an absent row means
    // a deeper data-integrity bug that deserves an explicit signal.)
    const projectRow = await this.knex.raw(
      'SELECT 1 FROM resources WHERE rid = ?',
      [projectRid],
    );
    if (((projectRow as { rows?: unknown[] }).rows ?? []).length === 0) {
      throw new AppError(
        'Dataset cannot be deleted: project resource not registered.',
        409,
        'RESOURCE_ORPHANED',
      );
    }

    const spaceRid = 'ri.compass.main.space.00000000-0000-0000-0000-000000000000';

    const snapshotPayload = {
      version: 1,
      capturedAt: new Date().toISOString(),
      dataset: {
        id: dataset.id,
        name: dataset.name,
        folder_id: dataset.folder_id,
        project_id: dataset.project_id,
        file_path: dataset.file_path,
        original_filename: dataset.original_filename,
        mime_type: dataset.mime_type,
        file_size_bytes: dataset.file_size_bytes,
        row_count: dataset.row_count,
        row_count_exact: dataset.row_count_exact,
        column_count: dataset.column_count,
        schema_info: dataset.schema_info ?? null,
        markings: dataset.markings ?? null,
        status: dataset.status,
        format: dataset.format,
        content_hash: dataset.content_hash,
        last_output_schema_fingerprint: dataset.last_output_schema_fingerprint ?? null,
        created_at: dataset.created_at,
        updated_at: dataset.updated_at,
        created_by: dataset.created_by,
        updated_by: dataset.updated_by,
      },
      columns: columns.map((c: any) => ({
        column_name: c.column_name,
        column_type: c.column_type,
        ordinal_position: c.ordinal_position,
        nullable: c.nullable,
        sample_values: c.sample_values ?? null,
      })),
      versions: versions.map((v: any) => ({
        id: v.id,
        version_number: v.version_number,
        file_path: v.file_path,
        row_count: v.row_count,
        row_count_exact: v.row_count_exact,
        file_size_bytes: v.file_size_bytes,
        schema_info: v.schema_info ?? null,
        content_hash: v.content_hash,
        created_at: v.created_at,
        created_by: v.created_by,
      })),
    };

    await this.knex.transaction(async (trx) => {
      // 1) Mirror into resources with DIRECTLY_TRASHED — idempotent on rid.
      // ON CONFLICT handles the case where a previous mirror exists (e.g.
      // a re-delete after a partial failure in a prior attempt).
      await trx.raw(
        `INSERT INTO resources (
           rid, type, service, display_name,
           parent_folder_rid, project_rid, space_rid,
           trash_status, trashed_at, trashed_by, retention_until,
           etag, metadata, legacy_uuid,
           created_by, updated_by
         ) VALUES (
           ?, 'FOUNDRY_DATASET', 'foundry-datasets', ?,
           ?, ?, ?,
           'DIRECTLY_TRASHED', now(), ?, now() + INTERVAL '30 days',
           1, ?::jsonb, ?,
           ?, ?
         )
         ON CONFLICT (rid) DO UPDATE SET
           trash_status    = EXCLUDED.trash_status,
           trashed_at      = EXCLUDED.trashed_at,
           trashed_by      = EXCLUDED.trashed_by,
           retention_until = EXCLUDED.retention_until,
           metadata        = EXCLUDED.metadata,
           updated_by      = EXCLUDED.updated_by,
           updated_at      = now()`,
        [
          datasetRid,
          dataset.name,
          parentFolderRid,
          projectRid,
          spaceRid,
          actorId ?? null,
          JSON.stringify({ snapshot: snapshotPayload }),
          datasetId,
          actorId ?? null,
          actorId ?? null,
        ],
      );

      // 2) Hard-delete from the source-of-truth tables. Order matters
      // because of foreign key constraints from columns/versions to dataset.
      await trx('dataset_columns').where({ dataset_id: datasetId }).delete();
      await trx('dataset_versions').where({ dataset_id: datasetId }).delete();
      await trx('foundry_datasets').where({ id: datasetId }).delete();
    });
  }

  async duplicateDataset(datasetId: string, userId?: string): Promise<any> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw NotFoundError('Dataset not found');

    // Resolve project_id even when the source row stores it implicitly
    // through `folder_id`. Without this the duplicate ends up with
    // `project_id = NULL`, which silently breaks every downstream
    // operation that anchors against the project (delete → trash mirror,
    // catalog facets, lineage joins).
    let projectId: string | null = (dataset.project_id as string | null) ?? null;
    if (!projectId && dataset.folder_id) {
      const folder = await this.knex('folders')
        .where({ id: dataset.folder_id })
        .first('project_id') as { project_id?: string } | undefined;
      projectId = folder?.project_id ?? null;
    }
    if (!projectId) {
      throw new AppError(
        'Cannot duplicate dataset: source has no parent project.',
        409,
        'RESOURCE_ORPHANED',
      );
    }

    const newName = dataset.name.replace(/(\.[^.]+)$/, ' (copy)$1');
    // NOTE: file_path and content_hash are copied verbatim — the
    // duplicate references the same S3 object as the source. Hard-delete
    // of either row deliberately leaves the object in place; physical
    // GC is gated on a separate reference-count sweep (see TRASH-RETENTION).
    const [dup] = await this.knex('foundry_datasets').insert({
      name: newName,
      project_id: projectId,
      folder_id: dataset.folder_id,
      file_path: dataset.file_path,
      original_filename: dataset.original_filename,
      mime_type: dataset.mime_type,
      file_size_bytes: dataset.file_size_bytes,
      row_count: dataset.row_count,
      row_count_exact: dataset.row_count_exact ?? null,
      column_count: dataset.column_count,
      schema_info: dataset.schema_info ? JSON.stringify(dataset.schema_info) : null,
      markings: dataset.markings ?? null,
      status: dataset.status,
      format: dataset.format ?? null,
      content_hash: dataset.content_hash,
      last_output_schema_fingerprint: dataset.last_output_schema_fingerprint ?? null,
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
