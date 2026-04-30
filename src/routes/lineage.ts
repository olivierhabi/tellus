// ---------------------------------------------------------------------------
// Lineage routes — PB-B8.
//
// GET /api/v2/datasets/:id/lineage?direction=&depth=N
//   Returns {nodes:[...], edges:[...]}. `direction` defaults to
//   'downstream', `depth` to 3 (cap 10). The response shape is the
//   graph the frontend renders in the Lineage panel.
//
// Uses the shared DatasetLineageService so the walk + cycle invariants
// are identical across callers (deploy fan-out, admin UI, CLI).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { AppError } from "../utils/foundryAppError";
import {
  DatasetLineageService,
  DEFAULT_LINEAGE_DEPTH,
  MAX_LINEAGE_DEPTH,
} from "../services/pipelines/datasetLineage";

const router = Router();
const lineage = new DatasetLineageService();

router.get(
  "/datasets/:datasetId/lineage",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const datasetId = req.params.datasetId;
      if (!datasetId || !/^[0-9a-f-]{36}$/i.test(datasetId)) {
        throw new AppError("Invalid dataset id", 400, "VALIDATION_ERROR");
      }
      const directionRaw = (req.query.direction as string | undefined) ?? "downstream";
      if (directionRaw !== "upstream" && directionRaw !== "downstream") {
        throw new AppError(
          "direction must be 'upstream' or 'downstream'",
          400,
          "VALIDATION_ERROR",
        );
      }
      const depthRaw = Number(req.query.depth ?? DEFAULT_LINEAGE_DEPTH);
      if (!Number.isFinite(depthRaw) || depthRaw < 1) {
        throw new AppError(
          "depth must be a positive integer",
          400,
          "VALIDATION_ERROR",
        );
      }
      if (depthRaw > MAX_LINEAGE_DEPTH) {
        throw new AppError(
          `depth must be <= ${MAX_LINEAGE_DEPTH}`,
          400,
          "LINEAGE_DEPTH_TOO_LARGE",
        );
      }
      const graph = await lineage.walk(datasetId, directionRaw, Math.floor(depthRaw));
      res.json({ success: true, data: graph });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
