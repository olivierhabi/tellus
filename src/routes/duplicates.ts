import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { HashController } from '../controllers/hashController';
import { HashService } from '../services/hashService';
import foundryDb from '../config/foundryDb';

const hashService = new HashService(foundryDb);
const hashController = new HashController(hashService);

export const projectDuplicatesRouter = Router({ mergeParams: true });
projectDuplicatesRouter.get('/:projectId/duplicates', authenticate, hashController.findDuplicates);

export const datasetDeduplicateRouter = Router();
datasetDeduplicateRouter.post('/:datasetId/deduplicate', authenticate, hashController.deduplicateDataset);
