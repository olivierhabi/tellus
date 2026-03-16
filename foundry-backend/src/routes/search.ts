import { Router } from 'express';
import { SearchController } from '@/controllers/searchController';
import { SearchService } from '@/services/searchService';
import { authenticate } from '@/middleware/auth';
import db from '@/config/database';

const router = Router();
const searchService = new SearchService(db);
const searchController = new SearchController(searchService);

router.get('/', authenticate, searchController.search);
router.get('/suggest', authenticate, searchController.suggest);

export default router;
