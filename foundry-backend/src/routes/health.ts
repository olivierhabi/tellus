import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /health
 * Returns server health status with timestamp and uptime.
 */
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

export default router;
