import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { FolderController } from '../controllers/folderController';
import { FolderService } from '../services/folderService';
import foundryDb from '../config/foundryDb';

const router = Router({ mergeParams: true });
const folderService = new FolderService(foundryDb);
const folderController = new FolderController(folderService);

router.post('/', authenticate, folderController.create);
router.get('/', authenticate, folderController.list);
router.get('/tree', authenticate, folderController.getProjectTree);
router.get('/:folderId', authenticate, folderController.getById);
router.get('/:folderId/tree', authenticate, folderController.getTree);
router.get('/:folderId/breadcrumb', authenticate, folderController.getBreadcrumb);
router.put('/:folderId', authenticate, folderController.update);
router.delete('/:folderId', authenticate, folderController.delete);

export default router;
