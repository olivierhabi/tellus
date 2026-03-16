import { Router } from 'express';
import { authenticate, authorize } from '@/middleware/auth';
import { UploadController } from '@/controllers/uploadController';
import { UploadService } from '@/services/uploadService';
import { ProjectService } from '@/services/projectService';
import { FolderService } from '@/services/folderService';
import db from '@/config/database';

const router = Router({ mergeParams: true });

// Wire up services
const uploadService = new UploadService(db);
const projectService = new ProjectService(db);
const folderService = new FolderService(db);
const uploadController = new UploadController(uploadService, projectService, folderService);

// POST /api/projects/:projectId/folders/:folderId/upload
router.post('/upload', authenticate, authorize('editor', 'owner'), uploadController.upload);

export default router;
