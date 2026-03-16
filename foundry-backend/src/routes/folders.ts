import { Router } from 'express';
import { FolderController } from '@/controllers/folderController';
import { FolderService } from '@/services/folderService';
import db from '@/config/database';

const router = Router({ mergeParams: true });
const folderService = new FolderService(db);
const folderController = new FolderController(folderService);

router.post('/', folderController.create);
router.get('/', folderController.list);
router.get('/:folderId', folderController.getById);
router.get('/:folderId/tree', folderController.getTree);
router.get('/:folderId/breadcrumb', folderController.getBreadcrumb);
router.put('/:folderId', folderController.update);
router.delete('/:folderId', folderController.delete);

export default router;
