import { Router } from 'express';
import { ProjectController } from '../controllers/projectController';
import { ProjectService } from '../services/projectService';
import { fieldSelection } from '../middleware/fieldSelection';
import foundryDb from '../config/foundryDb';

const router = Router();
const projectService = new ProjectService(foundryDb);
const projectController = new ProjectController(projectService);

router.post('/', projectController.create);
router.get('/', fieldSelection({ allowedFields: ['id', 'name', 'description', 'owner_id', 'default_role', 'created_at', 'updated_at'] }), projectController.list);
router.get('/:id/stats', projectController.getStats);
router.get('/:id', projectController.getById);
router.put('/:id', projectController.update);
router.delete('/:id', projectController.delete);

export default router;
