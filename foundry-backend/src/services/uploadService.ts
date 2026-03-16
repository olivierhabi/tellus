import { Knex } from 'knex';
import * as fs from 'fs';
import { scheduleParseJob } from '@/jobs/parseDatasetJob';

/**
 * Format file size in human-readable form.
 */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export class UploadService {
  constructor(private knex: Knex) {}

  /**
   * Process uploaded files: insert dataset records in a transaction,
   * cleanup on failure, and schedule parse jobs on success.
   */
  async processUpload(
    projectId: string,
    folderId: string,
    ownerId: string,
    files: Express.Multer.File[]
  ): Promise<Record<string, unknown>[]> {
    const datasets: Record<string, unknown>[] = [];

    try {
      await this.knex.transaction(async (trx) => {
        for (const file of files) {
          const [dataset] = await trx('datasets')
            .insert({
              name: file.originalname,
              folder_id: folderId,
              file_path: file.path,
              original_filename: file.originalname,
              mime_type: file.mimetype,
              file_size_bytes: file.size,
              status: 'pending',
            })
            .returning('*');

          datasets.push(dataset);
        }
      });
    } catch (error) {
      // Cleanup all stored files on transaction failure
      await Promise.allSettled(
        files.map((file) =>
          fs.promises.unlink(file.path).catch(() => {
            // Ignore cleanup errors
          })
        )
      );
      throw error;
    }

    // After successful transaction, schedule parse jobs
    for (const dataset of datasets) {
      scheduleParseJob(dataset.id as string);
    }

    return datasets;
  }
}
