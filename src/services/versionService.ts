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
  row_count: number | null;
  column_count: number | null;
  schema_info: unknown;
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

    try {
      const columns = await this.knex('dataset_columns').where({ dataset_id: datasetId }).orderBy('ordinal_position', 'asc').select('column_name', 'column_type', 'ordinal_position', 'nullable');

      const [version] = await this.knex('dataset_versions')
        .insert({ dataset_id: datasetId, version_number: nextVersionNumber, file_path: versionFilePath, row_count: dataset.row_count, column_count: dataset.column_count, schema_info: JSON.stringify(columns), created_by: input.createdBy || null })
        .returning('*');

      // Resolve project_id from folder for correct WebSocket event delivery
      const folder = await this.knex('folders').where({ id: dataset.folder_id }).first();
      const projectId = folder?.project_id ?? dataset.folder_id;
      emitDatasetEvent('dataset:version:created', projectId, { datasetId, versionNumber: nextVersionNumber });
      return version;
    } catch (error) {
      await fs.promises.unlink(versionFilePath).catch(() => {});
      throw error;
    }
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
      let snapshotFilePath: string | null = path.join(versionDir, snapshotFileName);

      try { await fs.promises.copyFile(dataset.file_path, snapshotFilePath); }
      catch { snapshotFilePath = null; /* If current file doesn't exist, skip pre-restore snapshot */ }

      try {
        await fs.promises.copyFile(targetVersion.file_path, dataset.file_path);

        await trx('foundry_datasets').where({ id: datasetId }).update({ row_count: targetVersion.row_count, column_count: targetVersion.column_count, status: 'ready' });

        if (targetVersion.schema_info) {
          const schemaColumns = typeof targetVersion.schema_info === 'string' ? JSON.parse(targetVersion.schema_info) : targetVersion.schema_info;
          if (Array.isArray(schemaColumns)) {
            await trx('dataset_columns').where({ dataset_id: datasetId }).delete();
            for (const col of schemaColumns) {
              await trx('dataset_columns').insert({ dataset_id: datasetId, column_name: col.column_name, column_type: col.column_type, ordinal_position: col.ordinal_position, nullable: col.nullable });
            }
          }
        }

        const currentColumns = await trx('dataset_columns').where({ dataset_id: datasetId }).orderBy('ordinal_position', 'asc').select('column_name', 'column_type', 'ordinal_position', 'nullable');

        const [restoreVersion] = await trx('dataset_versions')
          .insert({ dataset_id: datasetId, version_number: nextVersionNumber, file_path: snapshotFilePath ?? targetVersion.file_path, row_count: targetVersion.row_count, column_count: targetVersion.column_count, schema_info: JSON.stringify(currentColumns), created_by: restoredBy || null })
          .returning('*');

        // Resolve project_id from folder for correct WebSocket event delivery
        const folder = await trx('folders').where({ id: dataset.folder_id }).first();
        const projectId = folder?.project_id ?? dataset.folder_id;
        emitDatasetEvent('dataset:version:restored', projectId, { datasetId, restoredFromVersion: versionNumber, newVersionNumber: nextVersionNumber });
        return restoreVersion;
      } catch (error) {
        if (snapshotFilePath) {
          await fs.promises.unlink(snapshotFilePath).catch(() => {});
        }
        throw error;
      }
    });
  }
}
