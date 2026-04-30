// ---------------------------------------------------------------------------
// /api/v1/pipelines/metrics — Prometheus scrape endpoint for the
// Pipeline Builder. Parallel to /api/v1/funnel/metrics.
//
// Exposition format is the same plain-text layout the Funnel produces,
// so the SRE's Prometheus scraper config can list both endpoints as
// scrape targets without per-subsystem parsing differences.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import { renderPrometheus } from "../services/pipelines/metrics";

const router = Router();

router.get("/metrics", (_req: Request, res: Response) => {
  res
    .status(200)
    .setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8")
    .send(renderPrometheus());
});

export default router;
