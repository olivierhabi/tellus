import { Request, Response, NextFunction } from 'express';
import { VersionService } from '../services/versionService';
import { AppError } from '../utils/foundryAppError';
import { z } from 'zod';

const UuidParam = z.string().uuid('Invalid UUID format');

const CreateVersionBodySchema = z.object({
  changeSummary: z.string().max(500).optional(),
});

const RestoreVersionBodySchema = z.object({
  versionNumber: z.number().int().min(1),
});

export class VersionController {
  constructor(private versionService: VersionService) {}

  private getOwnerId(req: Request): string {
    const user = (req as unknown as { user?: { id: string } }).user;
    if (!user?.id) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    return user.id;
  }

  /**
   * GET /api/datasets/:datasetId/versions
   * List all versions for a dataset.
   */
  listVersions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const versions = await this.versionService.listVersions(datasetId);
      res.json({ success: true, data: versions });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/datasets/:datasetId/versions/:versionNumber
   * Get a specific version.
   */
  getVersion = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const versionNumber = parseInt(req.params.versionNumber as string, 10);
      if (isNaN(versionNumber) || versionNumber < 1) {
        throw new AppError('Invalid version number', 400, 'VALIDATION_ERROR');
      }

      const version = await this.versionService.getVersion(datasetId, versionNumber);
      res.json({ success: true, data: version });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/datasets/:datasetId/versions
   * Create a new version snapshot.
   */
  createVersion = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const bodyParsed = CreateVersionBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const ownerId = this.getOwnerId(req);
      const version = await this.versionService.createVersion(datasetId, {
        changeSummary: bodyParsed.data.changeSummary,
        createdBy: ownerId,
      });

      res.status(201).json({ success: true, data: version });
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/datasets/:datasetId/versions/restore
   * Restore a dataset to a previous version.
   */
  restoreVersion = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId as string;
      if (!UuidParam.safeParse(datasetId).success) {
        throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
      }

      const bodyParsed = RestoreVersionBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new AppError(bodyParsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }

      const ownerId = this.getOwnerId(req);
      const version = await this.versionService.restoreVersion(
        datasetId,
        bodyParsed.data.versionNumber,
        ownerId
      );

      res.json({ success: true, data: version });
    } catch (error) {
      next(error);
    }
  };
}
