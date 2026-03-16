import { Router } from 'express';
import { authenticate } from '@/middleware/auth';
import { VersionController } from '@/controllers/versionController';
import { VersionService } from '@/services/versionService';
import db from '@/config/database';

// Wire up services
const versionService = new VersionService(db);
const versionController = new VersionController(versionService);

/**
 * Dataset versions router.
 * Mounted at: /api/datasets
 */
const router = Router();

// GET /api/datasets/:datasetId/versions
router.get('/:datasetId/versions', authenticate, versionController.listVersions);

// GET /api/datasets/:datasetId/versions/:versionNumber
router.get(
  '/:datasetId/versions/:versionNumber',
  authenticate,
  versionController.getVersion
);

// POST /api/datasets/:datasetId/versions
router.post('/:datasetId/versions', authenticate, versionController.createVersion);

// POST /api/datasets/:datasetId/versions/restore
router.post(
  '/:datasetId/versions/restore',
  authenticate,
  versionController.restoreVersion
);

export default router;
