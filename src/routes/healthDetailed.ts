import { Router } from 'express';
import foundryDb from '../config/foundryDb';
import os from 'os';

const healthDetailedRouter = Router();

healthDetailedRouter.get('/detailed', async (req, res, next) => {
  try {
    // Database check
    let dbStatus = 'connected';
    try {
      await foundryDb.raw('SELECT 1');
    } catch {
      dbStatus = 'disconnected';
    }

    // Disk info (approximate via os)
    const freeMem = os.freemem();
    const totalMem = os.totalmem();

    // Uptime
    const uptimeSeconds = process.uptime();
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const uptimeFormatted = `${days} days, ${hours} hours, ${minutes} minutes`;

    const healthy = dbStatus === 'connected';
    res.status(healthy ? 200 : 503).json({
      success: true,
      data: {
        status: healthy ? 'healthy' : 'degraded',
        database: { status: dbStatus },
        memory: {
          used: `${Math.round((totalMem - freeMem) / 1024 / 1024)} MB`,
          total: `${Math.round(totalMem / 1024 / 1024)} MB`,
          status: 'ok',
        },
        uptime: uptimeFormatted,
        version: process.env.npm_package_version || '0.3.0',
      },
    });
  } catch (err) { next(err); }
});

export { healthDetailedRouter };
