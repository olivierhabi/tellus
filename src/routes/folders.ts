import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { FolderController } from '../controllers/folderController';
import { FolderService } from '../services/folderService';
import { shortCache } from '../middleware/cacheControl';
import foundryDb from '../config/foundryDb';

const router = Router({ mergeParams: true });
const folderService = new FolderService(foundryDb);
const folderController = new FolderController(folderService);

// ---------------------------------------------------------------------------
// Cache-Control policy — child-list endpoints are NOT browser-cached.
//
// The folder workspace's primary work surface mutates constantly (uploads,
// dataset deletions, sub-folder creates, pipeline runs). A `Cache-Control:
// max-age=N` directive caches the response in the BROWSER's HTTP cache,
// which is ORTHOGONAL to TanStack Query's in-memory cache — invalidating
// React Query won't bust the browser cache. So a freshly uploaded file is
// invisible until the directive expires.
//
// We trade the < 30s "instant prefetch" perf win for correctness: workspace
// reads always go to the server. The breadcrumb endpoint keeps `shortCache`
// because it returns just `[{id, name}]` — folder rename is the only thing
// that mutates it, and that path already invalidates React Query directly.
// ---------------------------------------------------------------------------

router.post('/', authenticate, folderController.create);
router.get('/', authenticate, folderController.list);
router.get('/tree', authenticate, folderController.getProjectTree);
router.get('/:folderId', authenticate, folderController.getById);
router.get('/:folderId/tree', authenticate, folderController.getTree);
router.get('/:folderId/breadcrumb', authenticate, shortCache(60), folderController.getBreadcrumb);
router.put('/:folderId', authenticate, folderController.update);
router.delete('/:folderId', authenticate, folderController.delete);

export default router;
