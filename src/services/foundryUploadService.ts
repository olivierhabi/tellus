import { Knex } from 'knex';
import { scheduleParseJob } from '../jobs/parseDatasetJob';
import { buildObjectKey, uploadObject, deleteObject } from './storageService';
import { ROOT_SPACE_RID } from '../lib/rid';

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

      // 2. Insert dataset records + Compass `resources` rows in a single
      //    transaction (B1-C-24). Both succeed or both roll back.
      const projectRid = `ri.compass.main.project.${projectId}`;
      const parentFolderRid = folderId
        ? `ri.compass.main.compass-folder.${folderId}`
        : null;

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
              created_by: ownerId,
              updated_by: ownerId,
            })
            .returning('*');
          datasets.push(dataset);

          const datasetRid = `ri.compass.main.foundry-dataset.${dataset.id}`;
          await trx.raw(
            `
            INSERT INTO resources (rid, service, type, display_name,
                                   parent_folder_rid, project_rid, space_rid,
                                   created_by, created_at, updated_by, updated_at,
                                   legacy_uuid)
            VALUES (?, 'compass', 'FOUNDRY_DATASET', ?,
                    ?, ?, ?,
                    ?, ?, ?, ?,
                    ?)
            ON CONFLICT (legacy_uuid) DO NOTHING
            `,
            [
              datasetRid,
              dataset.name,
              parentFolderRid,
              projectRid,
              ROOT_SPACE_RID,
              ownerId,
              dataset.created_at,
              ownerId,
              dataset.updated_at,
              dataset.id,
            ],
          );
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
