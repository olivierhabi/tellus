import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import { ColumnStatsController } from '@/controllers/columnStatsController';
import { ColumnStatsService } from '@/services/columnStatsService';
import db from '@/config/database';

// Wire up services
const columnStatsService = new ColumnStatsService(db);
const columnStatsController = new ColumnStatsController(columnStatsService);

/**
 * Column stats router.
 * Mounted at: /api/datasets
 */
const router = Router();

// GET /api/datasets/:datasetId/columns/:columnName/stats
router.get(
  '/:datasetId/columns/:columnName/stats',
  authenticate,
  columnStatsController.getColumnStats
);

// GET /api/datasets/:datasetId/profile
router.get(
  '/:datasetId/profile',
  authenticate,
  columnStatsController.getDatasetProfile
);

export default router;
