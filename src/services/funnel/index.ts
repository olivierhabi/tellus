/**
 * B9 — Funnel service bootstrap. Mounts routes and exports the public API.
 */
import type { Router } from "express";
import db from "../../db";
import { FunnelBindingsRepo } from "./bindings/repo";
import { buildFunnelRouter } from "./handlers";
import { CheckpointRepo } from "./pipeline/streaming-consumer";

export function createFunnelRouter(): Router {
  const repo = new FunnelBindingsRepo(db);
  const checkpoints = new CheckpointRepo(db);
  return buildFunnelRouter(repo, checkpoints);
}

export { FunnelBindingsRepo, CheckpointRepo };
export * from "./contracts/object-type-binding";
