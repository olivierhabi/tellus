import { Knex } from 'knex';
import { scheduleParseJob } from '../jobs/parseDatasetJob';
import { buildObjectKey, uploadObject, deleteObject } from './storageService';
import { ROOT_SPACE_RID } from '../lib/rid';

/**
 * Format a byte count into a human-readable size using base-1024 (IEC).
 *
 * Production rendering rules — must stay byte-identical to the
 * frontend `formatFileSize` in `tellus-fe/lib/format.ts` so the same
 * dataset row renders the same string whether the value is computed
 * server-side (upload response) or client-side (file browser).
 *
 *   - 3 significant figures.
 *   - Trailing zeros and trailing decimal points are stripped:
 *     1024 → "1 KB" (not "1.00 KB"), 90 136 B → "88 KB" (not "88.0 KB").
 *   - Bytes render as a non-negative integer with locale-aware
 *     thousand-separators ("823 B", "1,023 B").
 *   - 0 / NaN / Infinity / negative collapse to "0 B".
 *   - Very large integer parts get locale-aware separators ("1,234 TB").
 *
 * Accepts `number | string | bigint | null | undefined` so callers that
 * read directly from `knex().select('file_size_bytes')` (a Postgres
 * BIGINT, serialised as a JS string by node-postgres to preserve 64-bit
 * precision) don't silently collapse to "0 B". Coercion is performed
 * once, at this single boundary.
 *
 * Contract is pinned by `tests/foundry/unit/foundry-unit.test.ts`.
 */
export function formatFileSize(
  bytes: number | string | bigint | null | undefined,
): string {
  let n: number;
  if (bytes == null) return '0 B';
  if (typeof bytes === 'bigint') n = Number(bytes.toString());
  else if (typeof bytes === 'string') {
    if (bytes.trim() === '') return '0 B';
    n = Number(bytes);
  } else n = bytes;

  if (!Number.isFinite(n) || n <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const k = 1024;
  const i = Math.min(
    Math.floor(Math.log(n) / Math.log(k)),
    units.length - 1,
  );

  if (i === 0) {
    return `${Math.round(n).toLocaleString('en-US')} B`;
  }

  const size = n / Math.pow(k, i);
  const sig = size >= 100 ? 0 : size >= 10 ? 1 : 2;

  const fixed = size.toFixed(sig);
  const trimmed = fixed.includes('.')
    ? fixed.replace(/0+$/, '').replace(/\.$/, '')
    : fixed;

  const [intPart, fracPart] = trimmed.split('.');
  const grouped = Number(intPart).toLocaleString('en-US');
  const display = fracPart ? `${grouped}.${fracPart}` : grouped;

  return `${display} ${units[i]}`;
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
