import { Request, Response, NextFunction } from 'express';
import { HashService } from '@/services/hashService';
import { AppError } from '@/utils/AppError';
import { z } from 'zod';

const UuidParam = z.string().uuid('Invalid UUID format');

export class HashController {
  constructor(private hashService: HashService) {}

  /**
   * GET /api/projects/:projectId/duplicates
   * Find all duplicate files within a project.
   */
  findDuplicates = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const projectId = req.params.projectId as string;
      if (!UuidParam.safeParse(projectId).success) {
        throw new AppError('Invalid project ID format', 400, 'VALIDATION_ERROR');
      }

      const duplicates = await this.hashService.findDuplicates(projectId);
      res.json({
        success: true,
        data: {
          groupCount: duplicates.length,
          groups: duplicates,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/datasets/:datasetId/deduplicate
   * Check if a dataset is a duplicate and compute its hash.
   */
  deduplicateDataset = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const result = await this.hashService.deduplicateDataset(datasetId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };
}
