import { Knex } from 'knex';
import * as crypto from 'crypto';
import * as path from 'path';
import { AppError } from '../utils/foundryAppError';
import { emitDatasetEvent } from '../utils/emitEvent';
import { getObjectBuffer, uploadObject, objectExists } from './storageService';

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

    // Copy the current file to a version key in S3
    const ext = path.extname(dataset.file_path);
    const baseName = path.basename(dataset.file_path, ext);
    const parentDir = path.dirname(dataset.file_path);
    const versionFileName = `${baseName}_v${nextVersionNumber}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const versionKey = `${parentDir}/versions/${versionFileName}`;

    // Read the current file from S3 and re-upload as a version snapshot
    const fileBuffer = await getObjectBuffer(dataset.file_path);
    await uploadObject(versionKey, fileBuffer, dataset.mime_type || 'text/csv');

    try {
      const columns = await this.knex('dataset_columns').where({ dataset_id: datasetId }).orderBy('ordinal_position', 'asc').select('column_name', 'column_type', 'ordinal_position', 'nullable');

      const [version] = await this.knex('dataset_versions')
        .insert({ dataset_id: datasetId, version_number: nextVersionNumber, file_path: versionKey, row_count: dataset.row_count, column_count: dataset.column_count, schema_info: JSON.stringify(columns), created_by: input.createdBy || null })
        .returning('*');

      // Resolve project_id from folder for correct WebSocket event delivery
      const folder = dataset.folder_id ? await this.knex('folders').where({ id: dataset.folder_id }).first() : null;
      const projectId = folder?.project_id ?? dataset.project_id ?? dataset.folder_id;
      emitDatasetEvent('dataset:version:created', projectId, { datasetId, versionNumber: nextVersionNumber });
      return version;
    } catch (error) {
      // Cleanup: delete the version file if DB insert fails
      const { deleteObject } = await import('./storageService');
      await deleteObject(versionKey).catch(() => {});
      throw error;
    }
  }

  async restoreVersion(datasetId: string, versionNumber: number, restoredBy?: string): Promise<DatasetVersion> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');

    const targetVersion = await this.knex('dataset_versions').where({ dataset_id: datasetId, version_number: versionNumber }).first();
    if (!targetVersion) throw new AppError(`Version ${versionNumber} not found for this dataset`, 404, 'VERSION_NOT_FOUND');

    // Verify the version file exists in S3
    const exists = await objectExists(targetVersion.file_path);
    if (!exists) throw new AppError(`Version ${versionNumber} file is no longer accessible`, 410, 'VERSION_FILE_MISSING');

    return this.knex.transaction(async (trx) => {
      const lastVersion = await trx('dataset_versions').where({ dataset_id: datasetId }).orderBy('version_number', 'desc').first();
      const nextVersionNumber = lastVersion ? lastVersion.version_number + 1 : 1;

      // Snapshot the current file before restoring
      const ext = path.extname(dataset.file_path);
      const baseName = path.basename(dataset.file_path, ext);
      const parentDir = path.dirname(dataset.file_path);
      const snapshotFileName = `${baseName}_v${nextVersionNumber}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      const snapshotKey = `${parentDir}/versions/${snapshotFileName}`;

      let snapshotKeyFinal: string | null = snapshotKey;
      try {
        const currentBuffer = await getObjectBuffer(dataset.file_path);
        await uploadObject(snapshotKey, currentBuffer, dataset.mime_type || 'text/csv');
      } catch {
        snapshotKeyFinal = null; // If current file doesn't exist, skip pre-restore snapshot
      }

      try {
        // Copy the version file over the current dataset key
        const versionBuffer = await getObjectBuffer(targetVersion.file_path);
        await uploadObject(dataset.file_path, versionBuffer, dataset.mime_type || 'text/csv');

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
          .insert({ dataset_id: datasetId, version_number: nextVersionNumber, file_path: snapshotKeyFinal ?? targetVersion.file_path, row_count: targetVersion.row_count, column_count: targetVersion.column_count, schema_info: JSON.stringify(currentColumns), created_by: restoredBy || null })
          .returning('*');

        // Resolve project_id from folder for correct WebSocket event delivery
        const folder = dataset.folder_id ? await trx('folders').where({ id: dataset.folder_id }).first() : null;
        const projectId = folder?.project_id ?? dataset.project_id ?? dataset.folder_id;
        emitDatasetEvent('dataset:version:restored', projectId, { datasetId, restoredFromVersion: versionNumber, newVersionNumber: nextVersionNumber });
        return restoreVersion;
      } catch (error) {
        if (snapshotKeyFinal) {
          const { deleteObject } = await import('./storageService');
          await deleteObject(snapshotKeyFinal).catch(() => {});
        }
        throw error;
      }
    });
  }
}
