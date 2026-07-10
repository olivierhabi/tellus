import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { AppError } from '../utils/foundryAppError';

const ALLOWED_EXTENSIONS = ['.csv', '.tsv', '.txt'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sanitize and generate a unique filename for uploaded files.
 */
function generateUniqueFilename(originalName: string): string {
  const sanitized = originalName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_');
  return `${uuidv4()}_${sanitized}`;
}

/**
 * Staging directory for foundry uploads. Files land here on disk via multer's
 * diskStorage and are then streamed from disk straight into the S3 multipart
 * upload by `foundryUploadService` (which deletes them once the upload
 * completes — see its `finally` block). diskStorage is deliberate: the prior
 * memoryStorage buffered the entire file in the API process's heap, so a 1 GB
 * upload (×10 files per request, ×N concurrent requests) was an OOM bomb and a
 * trivial self-inflicted DoS. Streaming off disk keeps the heap bounded by the
 * S3 `partSize` (5 MB), not by the file size.
 *
 * Configurable via UPLOAD_STAGING_DIR; defaults under DATA_DIR/uploads/_staging.
 */
function getStagingDir(): string {
  const dir =
    process.env.UPLOAD_STAGING_DIR ??
    path.join(process.env.DATA_DIR || './data', 'uploads', '_staging');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * File filter — only allow .csv, .tsv, .txt files.
 */
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        `Unsupported file type "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
        415,
        'UNSUPPORTED_FILE'
      )
    );
  }
};

/**
 * Disk-storage engine shared by both factories. Writes each accepted file to
 * the staging dir under its unique filename (the same name later used as the
 * S3 object key), so `file.path` and `(file as any).uniqueFilename` stay
 * consistent and downstream code can stream either without translating names.
 */
function createDiskStorage() {
  const stagingDir = getStagingDir();
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, stagingDir),
    filename: (_req, file, cb) =>
      cb(null, (file as any).uniqueFilename || generateUniqueFilename(file.originalname)),
  });
}

/**
 * Factory function that creates a configured multer upload middleware.
 * Uses DISK STORAGE — files are staged to disk, then streamed to S3/MinIO by
 * the upload service layer. The middleware stashes a `uniqueFilename` property
 * on each file (used as the S3 object key); the on-disk staged file lives at
 * `file.path` and is deleted by `foundryUploadService.processUpload` once the
 * S3 multipart upload completes.
 */
export function createUploadMiddleware(maxSizeMB: number) {
  const storage = createDiskStorage();

  const upload = multer({
    storage,
    fileFilter: (req: Request, file, cb) => {
      const projectId = req.params.projectId as string;
      const folderId = req.params.folderId as string;

      if (!projectId || !UUID_RE.test(projectId)) {
        return cb(new AppError('Invalid project ID', 400, 'VALIDATION_ERROR'));
      }
      if (!folderId || !UUID_RE.test(folderId)) {
        return cb(new AppError('Invalid folder ID', 400, 'VALIDATION_ERROR'));
      }

      // Generate unique filename and stash it on the file object (also used
      // as the on-disk staged filename by createDiskStorage above).
      (file as any).uniqueFilename = generateUniqueFilename(file.originalname);

      fileFilter(req, file, cb);
    },
    limits: {
      fileSize: maxSizeMB * 1024 * 1024,
      files: 10,
    },
  });

  return upload;
}

/**
 * Factory function that creates a configured multer upload middleware
 * for project-level uploads (no folderId in the URL).
 * Uses DISK STORAGE — files are staged to disk, then streamed to S3/MinIO.
 */
export function createProjectUploadMiddleware(maxSizeMB: number) {
  const storage = createDiskStorage();

  const upload = multer({
    storage,
    fileFilter: (req: Request, file, cb) => {
      const projectId = req.params.projectId as string;

      if (!projectId || !UUID_RE.test(projectId)) {
        return cb(new AppError('Invalid project ID', 400, 'VALIDATION_ERROR'));
      }

      // Generate unique filename and stash it on the file object (also used
      // as the on-disk staged filename by createDiskStorage above).
      (file as any).uniqueFilename = generateUniqueFilename(file.originalname);

      fileFilter(req, file, cb);
    },
    limits: {
      fileSize: maxSizeMB * 1024 * 1024,
      files: 10,
    },
  });

  return upload;
}
