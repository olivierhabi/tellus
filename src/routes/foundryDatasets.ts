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
datasetRouter.get('/:datasetId/download', authenticate, datasetController.download);
datasetRouter.put('/:datasetId', authenticate, datasetController.update);
datasetRouter.delete('/:datasetId', authenticate, datasetController.delete);
datasetRouter.post('/:datasetId/duplicate', authenticate, datasetController.duplicate);
// Re-parse a dataset's source file — recovers schemas that were
// silently truncated by the pre-`sanitizeCsvHeader` ingestion path. See
// `DatasetController.reparse` and `runbooks/csv-header-sanitization.md`.
datasetRouter.post('/:datasetId/reparse', authenticate, datasetController.reparse);
