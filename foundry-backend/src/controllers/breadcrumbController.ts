import { Request, Response, NextFunction } from 'express';
import { BreadcrumbService } from '@/services/breadcrumbService';
import { AppError } from '@/utils/AppError';
import { z } from 'zod';

const UuidParam = z.string().uuid();
const TypeParam = z.enum(['project', 'folder', 'dataset']);

export class BreadcrumbController {
  constructor(private breadcrumbService: BreadcrumbService) {}

  getBreadcrumb = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const type = req.params.type as string;
      const id = req.params.id as string;
      if (!TypeParam.safeParse(type).success) {
        throw new AppError('Invalid type. Use: project, folder, or dataset', 400, 'VALIDATION_ERROR');
      }
      if (!UuidParam.safeParse(id).success) {
        throw new AppError('Invalid UUID format', 400, 'VALIDATION_ERROR');
      }
      const includeChildren = req.query.includeChildren === 'true';
      const result = await this.breadcrumbService.getBreadcrumb(type, id, includeChildren);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };
}
