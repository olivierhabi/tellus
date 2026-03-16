import { Router } from 'express';
import { SearchController } from '../controllers/searchController';
import { SearchService } from '../services/searchService';
import { authenticate } from '../middleware/auth';
import foundryDb from '../config/foundryDb';

const router = Router();
const searchService = new SearchService(foundryDb);
const searchController = new SearchController(searchService);

router.get('/', authenticate, searchController.search);
router.get('/suggest', authenticate, searchController.suggest);

export default router;
