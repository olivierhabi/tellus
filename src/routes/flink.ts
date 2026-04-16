/**
 * /api/v2/flink — backend → Flink REST proxy used by the streaming
 * pipeline UI and the bash + Cypress integration tests.
 *
 *   GET /api/v2/flink/overview      → cluster overview
 *   GET /api/v2/flink/taskmanagers  → task manager list
 *   GET /api/v2/flink/jobs          → live job list
 */

import { Router, type Request, type Response } from "express";
import {
  getFlinkOverview,
  getFlinkTaskManagers,
  listFlinkJobs,
} from "../services/flinkService";

const router = Router();

router.get("/flink/overview", async (_req: Request, res: Response) => {
  try {
    const data = await getFlinkOverview();
    res.json({ success: true, data });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: { code: "FLINK_UNAVAILABLE", message: (err as Error).message },
    });
  }
});

router.get("/flink/taskmanagers", async (_req: Request, res: Response) => {
  try {
    const data = await getFlinkTaskManagers();
    res.json({ success: true, data });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: { code: "FLINK_UNAVAILABLE", message: (err as Error).message },
    });
  }
});

router.get("/flink/jobs", async (_req: Request, res: Response) => {
  try {
    const data = await listFlinkJobs();
    res.json({ success: true, data });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: { code: "FLINK_UNAVAILABLE", message: (err as Error).message },
    });
  }
});

export default router;
