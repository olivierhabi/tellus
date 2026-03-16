import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { AppError } from '@/utils/AppError';

const ALLOWED_EXTENSIONS = ['.csv', '.tsv', '.txt'];

/**
 * Factory function that creates a configured multer upload middleware.
 */
export function createUploadMiddleware(uploadDir: string, maxSizeMB: number) {
  const storage = multer.diskStorage({
    destination: (_req: Request, _file, cb) => {
      const req = _req as Request;
      const projectId = req.params.projectId as string;
      const folderId = req.params.folderId as string;
      const dest = path.join(uploadDir, projectId, folderId);
      fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
    filename: (_req, file, cb) => {
      // Sanitize original filename: remove path separators, special chars
      const sanitized = file.originalname
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_{2,}/g, '_');
      const uniqueName = `${uuidv4()}_${sanitized}`;
      cb(null, uniqueName);
    },
  });

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

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: maxSizeMB * 1024 * 1024,
      files: 10,
    },
  });
}
