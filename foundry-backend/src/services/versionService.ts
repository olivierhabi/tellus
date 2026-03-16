import { Knex } from 'knex';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AppError } from '@/utils/AppError';
import { emitDatasetEvent } from '@/utils/emitEvent';

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

  /**
   * List all versions for a dataset, ordered by version_number descending.
   */
  async listVersions(datasetId: string): Promise<DatasetVersion[]> {
    const dataset = await this.knex('datasets')
      .where({ id: datasetId })
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    const versions = await this.knex('dataset_versions')
      .where({ dataset_id: datasetId })
      .orderBy('version_number', 'desc');

    return versions;
  }

  /**
   * Get a specific version by dataset ID and version number.
   */
  async getVersion(datasetId: string, versionNumber: number): Promise<DatasetVersion> {
    const dataset = await this.knex('datasets')
      .where({ id: datasetId })
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    const version = await this.knex('dataset_versions')
      .where({ dataset_id: datasetId, version_number: versionNumber })
      .first();

    if (!version) {
      throw new AppError(
        `Version ${versionNumber} not found for this dataset`,
        404,
        'VERSION_NOT_FOUND'
      );
    }

    return version;
  }

  /**
   * Create a new immutable version snapshot from the current dataset state.
   * Copies the current file and records metadata.
   */
  async createVersion(
    datasetId: string,
    input: CreateVersionInput
  ): Promise<DatasetVersion> {
    const dataset = await this.knex('datasets')
      .where({ id: datasetId })
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    if (dataset.status !== 'ready') {
      throw new AppError(
        `Cannot create version while dataset status is "${dataset.status}"`,
        400,
        'DATASET_NOT_READY'
      );
    }

    // Determine the next version number
    const lastVersion = await this.knex('dataset_versions')
      .where({ dataset_id: datasetId })
      .orderBy('version_number', 'desc')
      .first();

    const nextVersionNumber = lastVersion ? lastVersion.version_number + 1 : 1;

    // Copy the current file to a versioned path
    const ext = path.extname(dataset.file_path);
    const versionDir = path.join(path.dirname(dataset.file_path), 'versions');
    await fs.promises.mkdir(versionDir, { recursive: true });

    const versionFileName = `${path.basename(dataset.file_path, ext)}_v${nextVersionNumber}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const versionFilePath = path.join(versionDir, versionFileName);

    await fs.promises.copyFile(dataset.file_path, versionFilePath);

    // Get the schema snapshot from current columns
    const columns = await this.knex('dataset_columns')
      .where({ dataset_id: datasetId })
      .orderBy('ordinal_position', 'asc')
      .select('column_name', 'column_type', 'ordinal_position', 'nullable');

    // Insert the version record; clean up copied file if insert fails
    let version: DatasetVersion;
    try {
      [version] = await this.knex('dataset_versions')
        .insert({
          dataset_id: datasetId,
          version_number: nextVersionNumber,
          file_path: versionFilePath,
          file_size_bytes: dataset.file_size_bytes,
          row_count: dataset.row_count,
          column_count: dataset.column_count,
          content_hash: dataset.content_hash,
          schema_snapshot: JSON.stringify(columns),
          change_summary: input.changeSummary || null,
          created_by: input.createdBy || null,
        })
        .returning('*');
    } catch (error) {
      // Clean up the copied file if the database insert fails
      try {
        await fs.promises.unlink(versionFilePath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }

    // Resolve project_id from folder for correct WebSocket event delivery
    const folder = await this.knex('folders').where({ id: dataset.folder_id }).first();
    const projectId = folder?.project_id ?? dataset.folder_id;

    // Emit version created event
    emitDatasetEvent('dataset:version:created', projectId, {
      datasetId,
      versionNumber: nextVersionNumber,
    });

    return version;
  }

  /**
   * Restore a dataset to a previous version.
   * Copies the version file back to the dataset's current file path
   * and creates a new version recording the restore action.
   */
  async restoreVersion(
    datasetId: string,
    versionNumber: number,
    restoredBy?: string
  ): Promise<DatasetVersion> {
    const dataset = await this.knex('datasets')
      .where({ id: datasetId })
      .first();

    if (!dataset) {
      throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    }

    const targetVersion = await this.knex('dataset_versions')
      .where({ dataset_id: datasetId, version_number: versionNumber })
      .first();

    if (!targetVersion) {
      throw new AppError(
        `Version ${versionNumber} not found for this dataset`,
        404,
        'VERSION_NOT_FOUND'
      );
    }

    // Verify the version file still exists
    try {
      await fs.promises.access(targetVersion.file_path, fs.constants.R_OK);
    } catch {
      throw new AppError(
        `Version ${versionNumber} file is no longer accessible`,
        410,
        'VERSION_FILE_MISSING'
      );
    }

    return this.knex.transaction(async (trx) => {
      // First, snapshot the current state as a new version
      const lastVersion = await trx('dataset_versions')
        .where({ dataset_id: datasetId })
        .orderBy('version_number', 'desc')
        .first();

      const nextVersionNumber = lastVersion ? lastVersion.version_number + 1 : 1;

      // Copy current file as a pre-restore snapshot
      const ext = path.extname(dataset.file_path);
      const versionDir = path.join(path.dirname(dataset.file_path), 'versions');
      await fs.promises.mkdir(versionDir, { recursive: true });

      const snapshotFileName = `${path.basename(dataset.file_path, ext)}_v${nextVersionNumber}_${crypto.randomBytes(4).toString('hex')}${ext}`;
      let snapshotFilePath: string | null = path.join(versionDir, snapshotFileName);

      try {
        await fs.promises.copyFile(dataset.file_path, snapshotFilePath);
      } catch {
        // If current file doesn't exist, skip pre-restore snapshot
        // and don't record the non-existent path in the version record
        snapshotFilePath = null;
      }

      // Copy the target version file to the current file path
      await fs.promises.copyFile(targetVersion.file_path, dataset.file_path);

      // Update dataset metadata from the version
      await trx('datasets')
        .where({ id: datasetId })
        .update({
          row_count: targetVersion.row_count,
          column_count: targetVersion.column_count,
          content_hash: targetVersion.content_hash,
          file_size_bytes: targetVersion.file_size_bytes,
          status: 'ready',
        });

      // Restore schema if available
      if (targetVersion.schema_snapshot) {
        const schemaColumns = typeof targetVersion.schema_snapshot === 'string'
          ? JSON.parse(targetVersion.schema_snapshot)
          : targetVersion.schema_snapshot;

        if (Array.isArray(schemaColumns)) {
          // Delete current columns and re-insert from snapshot
          await trx('dataset_columns').where({ dataset_id: datasetId }).delete();

          for (const col of schemaColumns) {
            await trx('dataset_columns').insert({
              dataset_id: datasetId,
              column_name: col.column_name,
              column_type: col.column_type,
              ordinal_position: col.ordinal_position,
              nullable: col.nullable,
            });
          }
        }
      }

      // Record the restore as a new version
      const currentColumns = await trx('dataset_columns')
        .where({ dataset_id: datasetId })
        .orderBy('ordinal_position', 'asc')
        .select('column_name', 'column_type', 'ordinal_position', 'nullable');

      // Use the target version's file_path as fallback if pre-restore snapshot failed
      const [restoreVersion] = await trx('dataset_versions')
        .insert({
          dataset_id: datasetId,
          version_number: nextVersionNumber,
          file_path: snapshotFilePath ?? targetVersion.file_path,
          file_size_bytes: targetVersion.file_size_bytes,
          row_count: targetVersion.row_count,
          column_count: targetVersion.column_count,
          content_hash: targetVersion.content_hash,
          schema_snapshot: JSON.stringify(currentColumns),
          change_summary: `Restored from version ${versionNumber}`,
          created_by: restoredBy || null,
        })
        .returning('*');

      // Resolve project_id from folder for correct WebSocket event delivery
      const folder = await trx('folders').where({ id: dataset.folder_id }).first();
      const projectId = folder?.project_id ?? dataset.folder_id;

      // Emit version restored event
      emitDatasetEvent('dataset:version:restored', projectId, {
        datasetId,
        restoredFromVersion: versionNumber,
        newVersionNumber: nextVersionNumber,
      });

      return restoreVersion;
    });
  }
}
