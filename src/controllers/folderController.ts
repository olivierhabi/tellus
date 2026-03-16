import { Request, Response, NextFunction } from 'express';
import { FolderService } from '../services/folderService';
import { CreateFolderSchema, UpdateFolderSchema } from '../types/folder';
import { AppError } from '../utils/foundryAppError';
import { FOLDER_EMPTY_HINTS } from '../utils/hints';
import { z } from 'zod';

const UuidParam = z.string().uuid('Invalid UUID format');

export class FolderController {
  constructor(private folderService: FolderService) {}

  private getOwnerId(req: Request): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    if (!user?.id) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    return user.id;
  }

  create = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      if (!UuidParam.safeParse(projectId).success) {
        throw new AppError('Invalid project ID format', 400, 'VALIDATION_ERROR');
      }
      const parsed = CreateFolderSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const ownerId = this.getOwnerId(req);
      const folder = await this.folderService.createFolder(
        projectId,
        parsed.data.name,
        parsed.data.parentFolderId ?? null,
        ownerId
      );
      res.status(201).json({ success: true, data: folder });
    } catch (error) {
      next(error);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      if (!UuidParam.safeParse(projectId).success) {
        throw new AppError('Invalid project ID format', 400, 'VALIDATION_ERROR');
      }
      const parentId = req.query.parentId as string | undefined;
      let parentIdValue: string | null = null;
      if (parentId && parentId !== 'null') {
        if (!UuidParam.safeParse(parentId).success) {
          throw new AppError('Invalid parentId format', 400, 'VALIDATION_ERROR');
        }
        parentIdValue = parentId;
      }
      const folders = await this.folderService.listFolders(projectId, parentIdValue);
      res.json({ success: true, data: folders });
    } catch (error) {
      next(error);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const folderId = req.params.folderId as string;
      if (!UuidParam.safeParse(projectId).success || !UuidParam.safeParse(folderId).success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const sortBy = (req.query.sortBy as string) || 'name';
      const sortOrder = (req.query.sortOrder as string) === 'desc' ? 'desc' : 'asc';
      const allowedSorts = ['name', 'status', 'file_size_bytes', 'row_count', 'column_count', 'original_filename', 'mime_type', 'created_at', 'updated_at'];
      if (!allowedSorts.includes(sortBy)) {
        throw new AppError(`Invalid sortBy. Allowed: ${allowedSorts.join(', ')}`, 400, 'VALIDATION_ERROR');
      }
      const folder = await this.folderService.getFolderById(projectId, folderId, sortBy, sortOrder as 'asc' | 'desc');
      if (!folder) {
        throw new AppError('Folder not found', 404, 'NOT_FOUND');
      }
      const response: any = { success: true, data: folder };
      if (folder.children.folders.length === 0 && folder.children.datasets.length === 0) {
        response.hints = FOLDER_EMPTY_HINTS;
      }
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  getProjectTree = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      if (!UuidParam.safeParse(projectId).success) {
        throw new AppError('Invalid project ID format', 400, 'VALIDATION_ERROR');
      }
      const tree = await this.folderService.getProjectFolderTree(projectId);
      res.json({ success: true, data: tree });
    } catch (error) {
      next(error);
    }
  };

  getTree = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const folderId = req.params.folderId as string;
      if (!UuidParam.safeParse(projectId).success || !UuidParam.safeParse(folderId).success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const tree = await this.folderService.getFolderTree(projectId, folderId);
      res.json({ success: true, data: tree });
    } catch (error) {
      next(error);
    }
  };

  getBreadcrumb = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const folderId = req.params.folderId as string;
      if (!UuidParam.safeParse(projectId).success || !UuidParam.safeParse(folderId).success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const breadcrumb = await this.folderService.getFolderBreadcrumb(projectId, folderId);
      res.json({ success: true, data: breadcrumb });
    } catch (error) {
      next(error);
    }
  };

  update = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const folderId = req.params.folderId as string;
      if (!UuidParam.safeParse(projectId).success || !UuidParam.safeParse(folderId).success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const parsed = UpdateFolderSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const ownerId = this.getOwnerId(req);
      const folder = await this.folderService.updateFolder(
        projectId,
        folderId,
        parsed.data,
        ownerId
      );
      res.json({ success: true, data: folder });
    } catch (error) {
      next(error);
    }
  };

  delete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      const folderId = req.params.folderId as string;
      if (!UuidParam.safeParse(projectId).success || !UuidParam.safeParse(folderId).success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const ownerId = this.getOwnerId(req);
      await this.folderService.deleteFolder(projectId, folderId, ownerId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };
}
