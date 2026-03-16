import { Request, Response, NextFunction } from 'express';
import { FolderService } from '@/services/folderService';
import { CreateFolderSchema, UpdateFolderSchema } from '@/types/folder';
import { AppError } from '@/utils/AppError';
import { z } from 'zod';

const UuidParam = z.string().uuid('Invalid UUID format');

export class FolderController {
  constructor(private folderService: FolderService) {}

  private getOwnerId(req: Request): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    return user?.id ?? '550e8400-e29b-41d4-a716-446655440000';
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
      const folder = await this.folderService.getFolderById(projectId, folderId);
      if (!folder) {
        throw new AppError('Folder not found', 404, 'NOT_FOUND');
      }
      res.json({ success: true, data: folder });
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
