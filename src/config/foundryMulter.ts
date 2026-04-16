import multer from 'multer';
import * as path from 'path';
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
 * Factory function that creates a configured multer upload middleware.
 * Uses MEMORY STORAGE — files are buffered in memory, then uploaded to S3/MinIO
 * by the upload service layer.
 *
 * The middleware attaches a `uniqueFilename` property to each file for use
 * by downstream S3 upload logic.
 */
export function createUploadMiddleware(maxSizeMB: number) {
  const storage = multer.memoryStorage();

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

      // Generate unique filename and stash it on the file object
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
 * Uses MEMORY STORAGE — files are buffered in memory, then uploaded to S3/MinIO.
 */
export function createProjectUploadMiddleware(maxSizeMB: number) {
  const storage = multer.memoryStorage();

  const upload = multer({
    storage,
    fileFilter: (req: Request, file, cb) => {
      const projectId = req.params.projectId as string;

      if (!projectId || !UUID_RE.test(projectId)) {
        return cb(new AppError('Invalid project ID', 400, 'VALIDATION_ERROR'));
      }

      // Generate unique filename and stash it on the file object
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
