import { Knex } from 'knex';
import * as fs from 'fs';
import { scheduleParseJob } from '../jobs/parseDatasetJob';
import { buildObjectKey, uploadObject, deleteObject } from './storageService';
import { recordProgress } from './uploadProgress';
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

  async processUpload(projectId: string, folderId: string | null, ownerId: string, files: Express.Multer.File[], uploadId?: string): Promise<Record<string, unknown>[]> {
    const datasets: Record<string, unknown>[] = [];
    const uploadedKeys: string[] = [];

    // Aggregate S3-stream progress (only reported when an uploadId is present,
    // i.e. the foundry dialog path). Files upload sequentially, so at any
    // moment one file is in flight: aggregate loaded = completed files' bytes
    // + the in-flight file's httpUploadProgress.loaded. total = sum of staged
    // file sizes (known because diskStorage staged them first).
    const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
    let completedBytes = 0;

    try {
      // 1. Stream each staged file to S3/MinIO. With diskStorage `file.path`
      //    is set and `file.buffer` is undefined; the buffer fallback only
      //    matters for any caller still on memoryStorage. Streaming the
      //    staged file (rather than buffering it) keeps the heap bounded by
      //    the S3 partSize, so a multi-GB upload can't OOM the process.
      for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
        const file = files[fileIndex];
        const uniqueFilename = (file as any).uniqueFilename || file.originalname;
        const objectKey = buildObjectKey(projectId, folderId, uniqueFilename);

        const body: Buffer | fs.ReadStream = file.path
          ? fs.createReadStream(file.path)
          : file.buffer;
        // Forward lib-storage's httpUploadProgress (per-file loaded/total) to
        // the progress store as an aggregate across all files in the request.
        const onProgress = uploadId
          ? (loaded: number) =>
              recordProgress(uploadId, {
                phase: 's3',
                loaded: completedBytes + loaded,
                total: totalBytes,
                fileIndex,
                fileName: file.originalname,
              })
          : undefined;
        await uploadObject(
          objectKey,
          body,
          file.mimetype,
          {
            'original-filename': file.originalname,
            'project-id': projectId,
            ...(folderId ? { 'folder-id': folderId } : {}),
            'owner-id': ownerId,
          },
          file.size,
          onProgress,
        );

        completedBytes += file.size || 0;
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

      // S3 + DB both committed — mark the upload done for any polling client.
      if (uploadId) {
        await recordProgress(uploadId, {
          phase: 's3',
          status: 'done',
          loaded: totalBytes,
          total: totalBytes,
        }).catch(() => {});
      }
    } catch (error) {
      // Mark the upload failed for any polling client, then roll back S3.
      if (uploadId) {
        await recordProgress(uploadId, {
          phase: 's3',
          status: 'error',
          message: error instanceof Error ? error.message : 'Upload failed',
        }).catch(() => {});
      }
      // Rollback: remove any S3 objects that were uploaded before the failure
      await Promise.allSettled(
        uploadedKeys.map((key) => deleteObject(key).catch(() => {}))
      );
      throw error;
    } finally {
      // Always remove the disk-staged multer files once the S3 upload (and any
      // rollback) is done. Files staged by diskStorage would otherwise leak on
      // every upload and eventually fill the staging volume. The async parse
      // job reads from S3 (dataset.file_path holds the S3 object key, not the
      // local staged path — see parseDatasetJob.ts → csvParsingService.parseFile),
      // so deleting the local copy here is safe.
      await Promise.allSettled(
        files.map((f) => {
          const stagedPath = f.path;
          return stagedPath
            ? fs.promises.unlink(stagedPath).catch(() => {})
            : Promise.resolve();
        }),
      );
    }

    // 3. Schedule async parse jobs
    for (const dataset of datasets) {
      scheduleParseJob(dataset.id as string);
    }

    return datasets;
  }
}
