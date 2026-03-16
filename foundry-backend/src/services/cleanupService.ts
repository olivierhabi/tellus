import { Knex } from 'knex';
import * as fs from 'fs';
import * as path from 'path';

export class CleanupService {
  constructor(private knex: Knex) {}

  async deleteDataset(datasetId: string): Promise<boolean> {
    const dataset = await this.knex('datasets').where({ id: datasetId }).first();
    if (!dataset) return false;
    
    await this.knex('datasets').where({ id: datasetId }).delete();
    
    try {
      await fs.promises.unlink(dataset.file_path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to delete file ${dataset.file_path}:`, err);
      }
    }
    return true;
  }

  async batchDeleteDatasets(datasetIds: string[]): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    
    const datasets = await this.knex('datasets').whereIn('id', datasetIds);
    
    await this.knex.transaction(async (trx) => {
      await trx('datasets').whereIn('id', datasetIds).delete();
    });
    
    await Promise.allSettled(
      datasets.map((d: Record<string, unknown>) =>
        fs.promises.unlink(d.file_path as string).catch(() => {})
      )
    );
    
    deleted = datasets.length;
    failed = datasetIds.length - datasets.length;
    
    return { deleted, failed };
  }

  async cleanOrphanedFiles(uploadDir: string): Promise<{ removedFiles: number }> {
    let removedFiles = 0;
    
    const allDatasetPaths = await this.knex('datasets').select('file_path');
    const knownPaths = new Set(allDatasetPaths.map((d: Record<string, unknown>) => d.file_path as string));
    
    const walkDir = async (dir: string): Promise<string[]> => {
      const files: string[] = [];
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...await walkDir(fullPath));
          } else {
            files.push(fullPath);
          }
        }
      } catch {
        // Directory doesn't exist
      }
      return files;
    };
    
    const allFiles = await walkDir(uploadDir);
    for (const filePath of allFiles) {
      if (!knownPaths.has(filePath)) {
        try {
          await fs.promises.unlink(filePath);
          removedFiles++;
        } catch {
          // Ignore
        }
      }
    }
    
    return { removedFiles };
  }

  async cleanOrphanedRecords(): Promise<{ removedRecords: number }> {
    const orphaned = await this.knex('datasets')
      .leftJoin('folders', 'datasets.folder_id', 'folders.id')
      .whereNull('folders.id')
      .select('datasets.id');
    
    if (orphaned.length > 0) {
      await this.knex('datasets')
        .whereIn('id', orphaned.map((r: Record<string, unknown>) => r.id as string))
        .delete();
    }
    
    return { removedRecords: orphaned.length };
  }
}
