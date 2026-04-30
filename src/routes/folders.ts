import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { FolderController } from '../controllers/folderController';
import { FolderService } from '../services/folderService';
import { shortCache } from '../middleware/cacheControl';
import foundryDb from '../config/foundryDb';

const router = Router({ mergeParams: true });
const folderService = new FolderService(foundryDb);
const folderController = new FolderController(folderService);

router.post('/', authenticate, folderController.create);
router.get('/', authenticate, shortCache(15), folderController.list);
router.get('/tree', authenticate, shortCache(30), folderController.getProjectTree);
router.get('/:folderId', authenticate, shortCache(15), folderController.getById);
router.get('/:folderId/tree', authenticate, shortCache(30), folderController.getTree);
router.get('/:folderId/breadcrumb', authenticate, shortCache(60), folderController.getBreadcrumb);
router.put('/:folderId', authenticate, folderController.update);
router.delete('/:folderId', authenticate, folderController.delete);

export default router;
