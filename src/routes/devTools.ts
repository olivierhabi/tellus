import { Router, Request, Response, NextFunction } from 'express';
import foundryDb from '../config/foundryDb';
import { authenticate } from '../middleware/auth';

const devRouter = Router();

// Only enable in development
if (process.env.NODE_ENV !== 'production') {
  devRouter.post('/seed', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Create sample data
      const userId = (req as any).user?.id;
      // Insert sample project
      const [project] = await foundryDb('projects').insert({
        name: 'Sample Project',
        description: 'Auto-seeded project for development',
        owner_id: userId,
        default_role: 'editor',
      }).returning('*').onConflict('name').ignore();

      res.json({ success: true, data: { message: 'Database seeded', project } });
    } catch (err) { next(err); }
  });

  devRouter.post('/reset', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Delete in correct FK order
      await foundryDb('dataset_columns').delete();
      await foundryDb('dataset_versions').delete();
      await foundryDb('foundry_datasets').delete();
      await foundryDb('folders').delete();
      await foundryDb('project_members').delete();
      await foundryDb('projects').delete();
      res.json({ success: true, data: { message: 'Database reset complete' } });
    } catch (err) { next(err); }
  });

  devRouter.get('/status', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [projects] = await foundryDb('projects').count('* as count');
      const [folders] = await foundryDb('folders').count('* as count');
      const [datasets] = await foundryDb('foundry_datasets').count('* as count');
      const seeded = Number(projects.count) > 0;
      res.json({
        success: true,
        data: {
          seeded,
          counts: {
            projects: Number(projects.count),
            folders: Number(folders.count),
            datasets: Number(datasets.count),
          },
        },
      });
    } catch (err) { next(err); }
  });
}

export { devRouter };
