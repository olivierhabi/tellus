import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { VersionController } from '../controllers/versionController';
import { VersionService } from '../services/versionService';
import foundryDb from '../config/foundryDb';

const versionService = new VersionService(foundryDb);
const versionController = new VersionController(versionService);

const router = Router();

router.get('/:datasetId/versions', authenticate, versionController.listVersions);
router.post('/:datasetId/versions/restore', authenticate, versionController.restoreVersion);
router.get('/:datasetId/versions/:versionNumber', authenticate, versionController.getVersion);
router.post('/:datasetId/versions', authenticate, versionController.createVersion);

export default router;
