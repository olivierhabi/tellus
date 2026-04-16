import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { authorizeRoles } from '../middleware/authorize';
import { UploadController } from '../controllers/uploadController';
import { UploadService } from '../services/foundryUploadService';
import { ProjectService } from '../services/projectService';
import { FolderService } from '../services/folderService';
import { DatasetService } from '../services/datasetService';
import foundryDb from '../config/foundryDb';

const router = Router({ mergeParams: true });

const uploadService = new UploadService(foundryDb);
const projectService = new ProjectService(foundryDb);
const folderService = new FolderService(foundryDb);
const datasetService = new DatasetService(foundryDb);
const uploadController = new UploadController(uploadService, projectService, folderService);

// POST /projects/:projectId/upload — upload files to project root
router.post('/upload', authenticate, authorizeRoles('editor', 'owner'), uploadController.uploadToProject);

// GET /projects/:projectId/datasets — list datasets at project root (folder_id IS NULL)
router.get('/datasets', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = req.params.projectId as string;
    const datasets = await datasetService.listProjectRootDatasets(projectId);
    res.json(datasets);
  } catch (error) {
    next(error);
  }
});

export default router;
