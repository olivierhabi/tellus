import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import { DatasetController } from '@/controllers/datasetController';
import { DatasetService } from '@/services/datasetService';
import db from '@/config/database';

// Wire up services
const datasetService = new DatasetService(db);
const datasetController = new DatasetController(datasetService);

/**
 * Folder-scoped datasets router (mergeParams: true).
 * Mounted at: /api/projects/:projectId/folders/:folderId/datasets
 */
export const folderDatasetsRouter = Router({ mergeParams: true });
folderDatasetsRouter.get('/', authenticate, datasetController.list);

/**
 * Top-level dataset router for direct dataset access by ID.
 * Mounted at: /api/datasets
 */
export const datasetRouter = Router();
datasetRouter.get('/:datasetId', authenticate, datasetController.getById);
datasetRouter.get('/:datasetId/preview', authenticate, datasetController.preview);
datasetRouter.get('/:datasetId/status', authenticate, datasetController.getStatus);
