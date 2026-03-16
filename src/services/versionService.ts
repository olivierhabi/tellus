import { Knex } from 'knex';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AppError } from '../utils/foundryAppError';
import { emitDatasetEvent } from '../utils/emitEvent';

export interface DatasetVersion {
  id: string;
  dataset_id: string;
  version_number: number;
  file_path: string;
  file_size_bytes: number;
  row_count: number | null;
  column_count: number | null;
  content_hash: string | null;
  schema_snapshot: unknown;
  change_summary: string | null;
  created_by: string | null;
  created_at: string;
}

export interface CreateVersionInput {
  changeSummary?: string;
  createdBy?: string;
}

export class VersionService {
  constructor(private knex: Knex) {}

  async listVersions(datasetId: string): Promise<DatasetVersion[]> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    return this.knex('dataset_versions').where({ dataset_id: datasetId }).orderBy('version_number', 'desc');
  }

  async getVersion(datasetId: string, versionNumber: number): Promise<DatasetVersion> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    const version = await this.knex('dataset_versions').where({ dataset_id: datasetId, version_number: versionNumber }).first();
    if (!version) throw new AppError(`Version ${versionNumber} not found for this dataset`, 404, 'VERSION_NOT_FOUND');
    return version;
  }

  async createVersion(datasetId: string, input: CreateVersionInput): Promise<DatasetVersion> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    if (dataset.status !== 'ready') throw new AppError(`Cannot create version while dataset status is "${dataset.status}"`, 400, 'DATASET_NOT_READY');

    const lastVersion = await this.knex('dataset_versions').where({ dataset_id: datasetId }).orderBy('version_number', 'desc').first();
    const nextVersionNumber = lastVersion ? lastVersion.version_number + 1 : 1;

    const ext = path.extname(dataset.file_path);
    const versionDir = path.join(path.dirname(dataset.file_path), 'versions');
    await fs.promises.mkdir(versionDir, { recursive: true });

    const versionFileName = `${path.basename(dataset.file_path, ext)}_v${nextVersionNumber}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const versionFilePath = path.join(versionDir, versionFileName);
    await fs.promises.copyFile(dataset.file_path, versionFilePath);

    const columns = await this.knex('dataset_columns').where({ dataset_id: datasetId }).orderBy('ordinal_position', 'asc').select('column_name', 'column_type', 'ordinal_position', 'nullable');

    const [version] = await this.knex('dataset_versions')
      .insert({ dataset_id: datasetId, version_number: nextVersionNumber, file_path: versionFilePath, file_size_bytes: dataset.file_size_bytes, row_count: dataset.row_count, column_count: dataset.column_count, content_hash: dataset.content_hash, schema_snapshot: JSON.stringify(columns), change_summary: input.changeSummary || null, created_by: input.createdBy || null })
      .returning('*');

    emitDatasetEvent('dataset:version:created', dataset.folder_id, { datasetId, versionNumber: nextVersionNumber });
    return version;
  }

  async restoreVersion(datasetId: string, versionNumber: number, restoredBy?: string): Promise<DatasetVersion> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');

    const targetVersion = await this.knex('dataset_versions').where({ dataset_id: datasetId, version_number: versionNumber }).first();
    if (!targetVersion) throw new AppError(`Version ${versionNumber} not found for this dataset`, 404, 'VERSION_NOT_FOUND');

    try { await fs.promises.access(targetVersion.file_path, fs.constants.R_OK); }
    catch { throw new AppError(`Version ${versionNumber} file is no longer accessible`, 410, 'VERSION_FILE_MISSING'); }

    return this.knex.transaction(async (trx) => {
      const lastVersion = await trx('dataset_versions').where({ dataset_id: datasetId }).orderBy('version_number', 'desc').first();
      const nextVersionNumber = lastVersion ? lastVersion.version_number + 1 : 1;

      const ext = path.extname(dataset.file_path);
      const versionDir = path.join(path.dirname(dataset.file_path), 'versions');
      await fs.promises.mkdir(versionDir, { recursive: true });

      const snapshotFileName = `${path.basename(dataset.file_path, ext)}_v${nextVersionNumber}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      const snapshotFilePath = path.join(versionDir, snapshotFileName);

      try { await fs.promises.copyFile(dataset.file_path, snapshotFilePath); }
      catch { /* If current file doesn't exist, skip pre-restore snapshot */ }

      await fs.promises.copyFile(targetVersion.file_path, dataset.file_path);

      await trx('foundry_datasets').where({ id: datasetId }).update({ row_count: targetVersion.row_count, column_count: targetVersion.column_count, content_hash: targetVersion.content_hash, file_size_bytes: targetVersion.file_size_bytes, status: 'ready' });

      if (targetVersion.schema_snapshot) {
        const schemaColumns = typeof targetVersion.schema_snapshot === 'string' ? JSON.parse(targetVersion.schema_snapshot) : targetVersion.schema_snapshot;
        if (Array.isArray(schemaColumns)) {
          await trx('dataset_columns').where({ dataset_id: datasetId }).delete();
          for (const col of schemaColumns) {
            await trx('dataset_columns').insert({ dataset_id: datasetId, column_name: col.column_name, column_type: col.column_type, ordinal_position: col.ordinal_position, nullable: col.nullable });
          }
        }
      }

      const currentColumns = await trx('dataset_columns').where({ dataset_id: datasetId }).orderBy('ordinal_position', 'asc').select('column_name', 'column_type', 'ordinal_position', 'nullable');

      const [restoreVersion] = await trx('dataset_versions')
        .insert({ dataset_id: datasetId, version_number: nextVersionNumber, file_path: snapshotFilePath, file_size_bytes: targetVersion.file_size_bytes, row_count: targetVersion.row_count, column_count: targetVersion.column_count, content_hash: targetVersion.content_hash, schema_snapshot: JSON.stringify(currentColumns), change_summary: `Restored from version ${versionNumber}`, created_by: restoredBy || null })
        .returning('*');

      emitDatasetEvent('dataset:version:restored', dataset.folder_id, { datasetId, restoredFromVersion: versionNumber, newVersionNumber: nextVersionNumber });
      return restoreVersion;
    });
  }
}
