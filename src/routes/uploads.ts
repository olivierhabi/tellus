import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { UploadController } from '../controllers/uploadController';
import { UploadService } from '../services/foundryUploadService';
import { ProjectService } from '../services/projectService';
import { FolderService } from '../services/folderService';
import foundryDb from '../config/foundryDb';

const router = Router({ mergeParams: true });

const uploadService = new UploadService(foundryDb);
const projectService = new ProjectService(foundryDb);
const folderService = new FolderService(foundryDb);
const uploadController = new UploadController(uploadService, projectService, folderService);

router.post('/upload', authenticate, authorize('editor', 'owner'), uploadController.upload);

export default router;
