import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { ProjectController } from '../controllers/projectController';
import { ProjectService } from '../services/projectService';
import { fieldSelection } from '../middleware/fieldSelection';
import foundryDb from '../config/foundryDb';

const router = Router();
const projectService = new ProjectService(foundryDb);
const projectController = new ProjectController(projectService);

router.post('/', authenticate, projectController.create);
router.get('/', authenticate, fieldSelection({ allowedFields: ['id', 'name', 'description', 'owner_id', 'default_role', 'created_at', 'updated_at'] }), projectController.list);
router.get('/:id/stats', authenticate, projectController.getStats);
router.get('/:id', authenticate, projectController.getById);
router.put('/:id', authenticate, projectController.update);
router.delete('/:id', authenticate, projectController.delete);

export default router;
