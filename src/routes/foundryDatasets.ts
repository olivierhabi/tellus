import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { DatasetController } from '../controllers/datasetController';
import { DatasetService } from '../services/datasetService';
import foundryDb from '../config/foundryDb';

const datasetService = new DatasetService(foundryDb);
const datasetController = new DatasetController(datasetService);

export const folderDatasetsRouter = Router({ mergeParams: true });
folderDatasetsRouter.get('/', authenticate, datasetController.list);

export const datasetRouter = Router();
datasetRouter.get('/status-batch', authenticate, datasetController.getStatusBatch);
datasetRouter.get('/:datasetId', authenticate, datasetController.getById);
datasetRouter.get('/:datasetId/preview', authenticate, datasetController.preview);
datasetRouter.get('/:datasetId/status', authenticate, datasetController.getStatus);
datasetRouter.get('/:datasetId/summary', authenticate, datasetController.getSummary);
