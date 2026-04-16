import { Knex } from 'knex';
import { scheduleParseJob } from '../jobs/parseDatasetJob';
import { buildObjectKey, uploadObject, deleteObject } from './storageService';

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export class UploadService {
  constructor(private knex: Knex) {}

  async processUpload(projectId: string, folderId: string | null, ownerId: string, files: Express.Multer.File[]): Promise<Record<string, unknown>[]> {
    const datasets: Record<string, unknown>[] = [];
    const uploadedKeys: string[] = [];

    try {
      // 1. Upload each file to S3/MinIO
      for (const file of files) {
        const uniqueFilename = (file as any).uniqueFilename || file.originalname;
        const objectKey = buildObjectKey(projectId, folderId, uniqueFilename);

        await uploadObject(objectKey, file.buffer, file.mimetype, {
          'original-filename': file.originalname,
          'project-id': projectId,
          ...(folderId ? { 'folder-id': folderId } : {}),
          'owner-id': ownerId,
        });

        uploadedKeys.push(objectKey);

        // Stash the S3 key on the file object for DB insert
        (file as any).s3Key = objectKey;
      }

      // 2. Insert dataset records in a transaction
      await this.knex.transaction(async (trx) => {
        for (const file of files) {
          const [dataset] = await trx('foundry_datasets')
            .insert({
              name: file.originalname,
              project_id: projectId,
              folder_id: folderId,
              file_path: (file as any).s3Key, // S3 object key stored as file_path
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
      // Rollback: remove any S3 objects that were uploaded before the failure
      await Promise.allSettled(
        uploadedKeys.map((key) => deleteObject(key).catch(() => {}))
      );
      throw error;
    }

    // 3. Schedule async parse jobs
    for (const dataset of datasets) {
      scheduleParseJob(dataset.id as string);
    }

    return datasets;
  }
}
