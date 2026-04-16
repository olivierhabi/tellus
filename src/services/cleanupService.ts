import { Knex } from 'knex';
import { deleteObject, deleteObjects, listObjects } from './storageService';

export class CleanupService {
  constructor(private knex: Knex) {}

  async deleteDataset(datasetId: string): Promise<boolean> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) return false;
    
    await this.knex('foundry_datasets').where({ id: datasetId }).delete();
    
    try {
      // file_path is now an S3 object key
      await deleteObject(dataset.file_path);
    } catch (err) {
      console.error(`[cleanup] Failed to delete S3 object ${dataset.file_path}:`, err);
    }
    return true;
  }

  async batchDeleteDatasets(datasetIds: string[]): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    
    const datasets = await this.knex('foundry_datasets').whereIn('id', datasetIds);
    
    await this.knex.transaction(async (trx) => {
      await trx('foundry_datasets').whereIn('id', datasetIds).delete();
    });
    
    // Batch delete S3 objects
    const keys = datasets.map((d: Record<string, unknown>) => d.file_path as string);
    if (keys.length > 0) {
      const result = await deleteObjects(keys);
      deleted = result.deleted;
      failed = result.errors;
    }
    
    // Adjust counts if some datasets weren't found in DB
    deleted = datasets.length;
    failed = datasetIds.length - datasets.length;
    
    return { deleted, failed };
  }

  /**
   * Clean orphaned files in S3 that have no matching database record.
   * Lists all objects under the configured bucket and compares with known file_path values.
   */
  async cleanOrphanedFiles(): Promise<{ removedFiles: number }> {
    let removedFiles = 0;
    
    const allDatasetPaths = await this.knex('foundry_datasets').select('file_path');
    const knownPaths = new Set(allDatasetPaths.map((d: Record<string, unknown>) => d.file_path as string));
    
    // List all objects under the projects/ prefix in S3
    const allKeys = await listObjects('projects/');
    const orphanKeys: string[] = [];

    for (const key of allKeys) {
      if (!knownPaths.has(key)) {
        orphanKeys.push(key);
      }
    }

    if (orphanKeys.length > 0) {
      const result = await deleteObjects(orphanKeys);
      removedFiles = result.deleted;
    }
    
    return { removedFiles };
  }

  async cleanOrphanedRecords(): Promise<{ removedRecords: number }> {
    const orphaned = await this.knex('foundry_datasets')
      .leftJoin('folders', 'foundry_datasets.folder_id', 'folders.id')
      .whereNull('folders.id')
      .whereNotNull('foundry_datasets.folder_id')
      .select('foundry_datasets.id');
    
    if (orphaned.length > 0) {
      await this.knex('foundry_datasets')
        .whereIn('id', orphaned.map((r: Record<string, unknown>) => r.id as string))
        .delete();
    }
    
    return { removedRecords: orphaned.length };
  }
}
