import { Request, Response, NextFunction } from 'express';
import { DatasetService } from '@/services/datasetService';
import { DatasetListQuerySchema, DatasetPreviewQuerySchema } from '@/types/dataset';
import { AppError } from '@/utils/AppError';
import { z } from 'zod';

const UuidParam = z.string().uuid('Invalid UUID format');

export class DatasetController {
  constructor(private datasetService: DatasetService) {}

  /**
   * List datasets in a folder with pagination.
   */
  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const folderId = req.params.folderId as string;
      if (!UuidParam.safeParse(folderId).success) {
        throw new AppError('Invalid folder ID format', 400, 'VALIDATION_ERROR');
      }

      const queryParsed = DatasetListQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        throw new AppError(queryParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const result = await this.datasetService.listDatasets(folderId, queryParsed.data);
      res.json({ success: true, data: result.datasets, meta: result.meta });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get a single dataset by ID with columns.
   */
  getById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const dataset = await this.datasetService.getDatasetById(datasetId);
      if (!dataset) {
        throw new AppError('Dataset not found', 404, 'NOT_FOUND');
      }

      res.json({ success: true, data: dataset });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get a preview of dataset rows.
   */
  preview = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const queryParsed = DatasetPreviewQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        throw new AppError(queryParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const preview = await this.datasetService.getDatasetPreview(
        datasetId,
        queryParsed.data.rows
      );

      // Set cache control header for preview responses
      res.set('Cache-Control', 'private, max-age=60');
      res.json({ success: true, data: preview });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get lightweight dataset status.
   */
  getStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const status = await this.datasetService.getDatasetStatus(datasetId);
      res.json({ success: true, data: status });
    } catch (error) {
      next(error);
    }
  };
}
