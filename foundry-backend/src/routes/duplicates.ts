import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import { HashController } from '@/controllers/hashController';
import { HashService } from '@/services/hashService';
import db from '@/config/database';

// Wire up services
const hashService = new HashService(db);
const hashController = new HashController(hashService);

/**
 * Project-level duplicates router.
 * Mounted at: /api/projects
 */
export const projectDuplicatesRouter = Router({ mergeParams: true });

// GET /api/projects/:projectId/duplicates
projectDuplicatesRouter.get(
  '/:projectId/duplicates',
  authenticate,
  hashController.findDuplicates
);

/**
 * Dataset-level deduplication router.
 * Mounted at: /api/datasets
 */
export const datasetDeduplicateRouter = Router();

// POST /api/datasets/:datasetId/deduplicate
datasetDeduplicateRouter.post(
  '/:datasetId/deduplicate',
  authenticate,
  hashController.deduplicateDataset
);
