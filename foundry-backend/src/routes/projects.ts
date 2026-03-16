import { Router } from 'express';
import { ProjectController } from '@/controllers/projectController';
import { ProjectService } from '@/services/projectService';
import db from '@/config/database';

const router = Router();
const projectService = new ProjectService(db);
const projectController = new ProjectController(projectService);

router.post('/', projectController.create);
router.get('/', projectController.list);
router.get('/:id', projectController.getById);
router.put('/:id', projectController.update);
router.delete('/:id', projectController.delete);

export default router;
