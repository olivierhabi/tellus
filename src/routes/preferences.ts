import { Router } from 'express';
import { PreferenceController } from '../controllers/preferenceController';
import { PreferenceService } from '../services/preferenceService';
import foundryDb from '../config/foundryDb';

const router = Router();
const preferenceService = new PreferenceService(foundryDb);
const preferenceController = new PreferenceController(preferenceService);

router.get('/', preferenceController.getAll);
router.get('/:key', preferenceController.getByKey);
router.put('/:key', preferenceController.update);
router.delete('/:key', preferenceController.remove);

export default router;
