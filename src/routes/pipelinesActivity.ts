// ---------------------------------------------------------------------------
// GET /api/v1/pipelines:activity — composite home-table read for the
// Pipeline Builder app home (/pipeline).
//
// Mirrors GET /api/v1/workshop/modules:activity: the caller's recently-viewed
// ∪ favorited pipelines, joined to live (non-archived) pipelines and
// enriched with the owning project name + creator display name. One request
// replaces the client-side fan-out (projects + per-project pipeline lists);
// stale recents rows whose pipeline was archived/deleted are filtered by the
// JOIN.
//
// Mounted at /api/v1 (next to pipelines-status) because the colon-literal
// path sits above the project-scoped `/api/v1/projects/:projectId/pipelines`
// surface.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../middleware/currentUser";
import { routeMetric } from "../utils/routeInstrumentation";
import { sendError } from "../utils/responseFormatter";
import { listPipelineActivity } from "../services/pipelines/pipelineActivityService";

const router = Router();

const activityQuerySchema = z
  .object({
    limit: z
      .preprocess(
        (v) => (typeof v === "string" ? parseInt(v, 10) : v),
        z.number().int().min(1).max(100),
      )
      .optional(),
  })
  .strict();

router.get(
  "/pipelines:activity",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      routeMetric(req, "pipelines.activity", null);
      const parsed = activityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "pipelines:activity query did not validate.",
        );
      }
      const result = await listPipelineActivity(currentUser(req), {
        limit: parsed.data.limit,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
