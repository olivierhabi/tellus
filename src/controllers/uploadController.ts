import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { createUploadMiddleware, createProjectUploadMiddleware } from '../config/foundryMulter';
import { foundryEnv } from '../config/foundryEnv';
import { AppError } from '../utils/foundryAppError';
import { UploadService, formatFileSize } from '../services/foundryUploadService';
import { ProjectService } from '../services/projectService';
import { FolderService } from '../services/folderService';

export class UploadController {
  private uploadMiddleware: ReturnType<typeof createUploadMiddleware>;
  private projectUploadMiddleware: ReturnType<typeof createProjectUploadMiddleware>;

  constructor(
    private uploadService: UploadService,
    private projectService: ProjectService,
    private folderService: FolderService
  ) {
    this.uploadMiddleware = createUploadMiddleware(foundryEnv.MAX_FILE_SIZE_MB);
    this.projectUploadMiddleware = createProjectUploadMiddleware(foundryEnv.MAX_FILE_SIZE_MB);
  }

  private getOwnerId(req: Request): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    if (!user?.id) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    return user.id;
  }

  upload = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const folderId = req.params.folderId as string;
      const ownerId = this.getOwnerId(req);

      // Validate project exists (authorizeRoles already verified membership)
      const exists = await this.projectService.projectExists(projectId);
      if (!exists) {
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }

      // Validate folder exists
      const folderExists = await this.folderService.folderExists(projectId, folderId);
      if (!folderExists) {
        throw new AppError('Folder not found', 404, 'NOT_FOUND');
      }

      // Run multer middleware
      await new Promise<void>((resolve, reject) => {
        this.uploadMiddleware.array('files', 10)(req, res, (err: unknown) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const files = (req as unknown as { files?: Express.Multer.File[] }).files;
      if (!files || files.length === 0) {
        throw new AppError('No files provided', 400, 'VALIDATION_ERROR');
      }

      // Process upload
      const datasets = await this.uploadService.processUpload(
        projectId,
        folderId,
        ownerId,
        files
      );

      // Build response with formatted file sizes
      const responseData = datasets.map((dataset) => ({
        ...dataset,
        fileSizeFormatted: formatFileSize(dataset.file_size_bytes as number),
      }));

      res.status(201).json({ success: true, data: responseData });
    } catch (error) {
      // Handle multer-specific errors
      if (error instanceof multer.MulterError) {
        switch (error.code) {
          case 'LIMIT_FILE_SIZE':
            return next(
              new AppError(
                `File too large. Maximum size is ${foundryEnv.MAX_FILE_SIZE_MB}MB`,
                413,
                'LIMIT_FILE_SIZE'
              )
            );
          case 'LIMIT_FILE_COUNT':
            return next(
              new AppError('Too many files. Maximum is 10 files per upload', 400, 'LIMIT_FILE_COUNT')
            );
          case 'LIMIT_UNEXPECTED_FILE':
            return next(
              new AppError('Unexpected file field. Use "files" as the field name', 400, 'LIMIT_UNEXPECTED_FILE')
            );
          default:
            return next(
              new AppError(`Upload error: ${error.message}`, 400, 'UPLOAD_ERROR')
            );
        }
      }
      next(error);
    }
  };

  /**
   * POST /projects/:projectId/upload
   * Upload files directly to a project. Auto-creates an "Uploads" folder
   * if one doesn't already exist at the project root level.
   */
  uploadToProject = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const ownerId = this.getOwnerId(req);

      // Validate project exists (authorizeRoles already verified membership)
      const exists = await this.projectService.projectExists(projectId);
      if (!exists) {
        throw new AppError('Project not found', 404, 'NOT_FOUND');
      }

      // Run multer middleware
      await new Promise<void>((resolve, reject) => {
        this.projectUploadMiddleware.array('files', 10)(req, res, (err: unknown) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const files = (req as unknown as { files?: Express.Multer.File[] }).files;
      if (!files || files.length === 0) {
        throw new AppError('No files provided', 400, 'VALIDATION_ERROR');
      }

      // Process upload — project-level (no folder)
      const datasets = await this.uploadService.processUpload(
        projectId,
        null,
        ownerId,
        files
      );

      // Build response with formatted file sizes
      const responseData = datasets.map((dataset) => ({
        ...dataset,
        fileSizeFormatted: formatFileSize(dataset.file_size_bytes as number),
      }));

      res.status(201).json({ success: true, data: responseData });
    } catch (error) {
      if (error instanceof multer.MulterError) {
        switch (error.code) {
          case 'LIMIT_FILE_SIZE':
            return next(
              new AppError(
                `File too large. Maximum size is ${foundryEnv.MAX_FILE_SIZE_MB}MB`,
                413,
                'LIMIT_FILE_SIZE'
              )
            );
          case 'LIMIT_FILE_COUNT':
            return next(
              new AppError('Too many files. Maximum is 10 files per upload', 400, 'LIMIT_FILE_COUNT')
            );
          case 'LIMIT_UNEXPECTED_FILE':
            return next(
              new AppError('Unexpected file field. Use "files" as the field name', 400, 'LIMIT_UNEXPECTED_FILE')
            );
          default:
            return next(
              new AppError(`Upload error: ${error.message}`, 400, 'UPLOAD_ERROR')
            );
        }
      }
      next(error);
    }
  };
}
