import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { PreferenceController } from '../controllers/preferenceController';
import { PreferenceService } from '../services/preferenceService';
import foundryDb from '../config/foundryDb';

const router = Router();
const preferenceService = new PreferenceService(foundryDb);
const preferenceController = new PreferenceController(preferenceService);

router.get('/', authenticate, preferenceController.getAll);
router.get('/:key', authenticate, preferenceController.getByKey);
router.put('/:key', authenticate, preferenceController.update);
router.delete('/:key', authenticate, preferenceController.remove);

export default router;
