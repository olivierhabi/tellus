import { Knex } from 'knex';
import * as fs from 'fs';
import { scheduleParseJob } from '../jobs/parseDatasetJob';

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export class UploadService {
  constructor(private knex: Knex) {}

  async processUpload(projectId: string, folderId: string, ownerId: string, files: Express.Multer.File[]): Promise<Record<string, unknown>[]> {
    const datasets: Record<string, unknown>[] = [];

    try {
      await this.knex.transaction(async (trx) => {
        for (const file of files) {
          const [dataset] = await trx('foundry_datasets')
            .insert({ name: file.originalname, folder_id: folderId, file_path: file.path, original_filename: file.originalname, mime_type: file.mimetype, file_size_bytes: file.size, status: 'pending' })
            .returning('*');
          datasets.push(dataset);
        }
      });
    } catch (error) {
      await Promise.allSettled(files.map((file) => fs.promises.unlink(file.path).catch(() => {})));
      throw error;
    }

    for (const dataset of datasets) {
      scheduleParseJob(dataset.id as string);
    }

    return datasets;
  }
}
