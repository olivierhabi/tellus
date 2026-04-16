import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { ColumnStatsController } from '../controllers/columnStatsController';
import { ColumnStatsService } from '../services/columnStatsService';
import foundryDb from '../config/foundryDb';

const columnStatsService = new ColumnStatsService(foundryDb);
const columnStatsController = new ColumnStatsController(columnStatsService);

const router = Router();

router.get('/:datasetId/columns/:columnName/stats', authenticate, columnStatsController.getColumnStats);
router.get('/:datasetId/profile', authenticate, columnStatsController.getDatasetProfile);

export default router;
