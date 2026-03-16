import { Router } from 'express';
import { BreadcrumbController } from '@/controllers/breadcrumbController';
import { BreadcrumbService } from '@/services/breadcrumbService';
import { authenticate } from '@/middleware/auth';
import db from '@/config/database';

const router = Router();
const breadcrumbService = new BreadcrumbService(db);
const breadcrumbController = new BreadcrumbController(breadcrumbService);

router.get('/:type/:id', authenticate, breadcrumbController.getBreadcrumb);

export default router;
