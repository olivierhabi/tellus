import { Request, Response, NextFunction } from 'express';
import { ColumnStatsService } from '@/services/columnStatsService';
import { AppError } from '@/utils/AppError';
import { z } from 'zod';

const UuidParam = z.string().uuid('Invalid UUID format');

export class ColumnStatsController {
  constructor(private columnStatsService: ColumnStatsService) {}

  /**
   * GET /api/datasets/:datasetId/columns/:columnName/stats
   * Get statistics for a single column.
   */
  getColumnStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const columnName = req.params.columnName as string;
      if (!columnName || columnName.trim().length === 0) {
        throw new AppError('Column name is required', 400, 'VALIDATION_ERROR');
      }

      const stats = await this.columnStatsService.getColumnStats(datasetId, columnName);
      res.json({ success: true, data: stats });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/datasets/:datasetId/profile
   * Get full dataset profile with all column statistics.
   */
  getDatasetProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const profile = await this.columnStatsService.getDatasetProfile(datasetId);

      // Cache profile for 5 minutes since it's read-heavy
      res.set('Cache-Control', 'private, max-age=300');
      res.json({ success: true, data: profile });
    } catch (error) {
      next(error);
    }
  };
}
