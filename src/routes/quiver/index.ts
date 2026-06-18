// Quiver — combined router. Mounted at /quiver/api/v1 by server.ts.
//
// Phase feature flag: TELLUS_QUIVER_PHASE controls which sub-routers are
// mounted. Cumulative — phase 3 implies 1+2.

import { Router } from "express";
import { analysesRouter } from "./analyses";
import { assertRegistryIntegrity } from "../../services/quiver/dag";

export interface QuiverPhaseFlags {
  phase: number;
}

export function readPhaseFlags(): QuiverPhaseFlags {
  const raw = process.env.TELLUS_QUIVER_PHASE ?? "0";
  const n = Number(raw);
  return { phase: Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0 };
}

export function buildQuiverRouter(flags: QuiverPhaseFlags = readPhaseFlags()): Router {
  // Boot-time invariant: 26 card types in registry (B2 C-02). Throws on drift.
  assertRegistryIntegrity();
  const r = Router();
  if (flags.phase >= 1) {
    r.use(analysesRouter);
  }
  return r;
}
