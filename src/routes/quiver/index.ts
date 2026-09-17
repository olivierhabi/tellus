// Quiver — combined router. Mounted at /quiver/api/v1 by server.ts.
//
// Phase feature flag: TELLUS_QUIVER_PHASE controls which sub-routers are
// mounted. Cumulative — phase 3 implies 1+2.

import { Router, type Request, type Response, type NextFunction } from "express";
import { analysesRouter } from "./analyses";
import { versionsRouter } from "./versions";
import { computeRouter } from "./compute";
import { registryRouter } from "./registry";
import { instructionsRouter } from "./instructions";
import { aipRouter } from "./aip";
import { publishingRouter } from "./publishing";
import { assertRegistryIntegrity } from "../../services/quiver/dag";
import { setCompassPort } from "../../services/quiver/analysisService";
import { dbCompassPort } from "../../services/quiver/dbCompassPort";

export interface QuiverPhaseFlags {
  phase: number;
}

export function readPhaseFlags(): QuiverPhaseFlags {
  const raw = process.env.TELLUS_QUIVER_PHASE ?? "0";
  const n = Number(raw);
  return { phase: Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0 };
}

let compassWired = false;
/**
 * Idempotent production wiring of the DB-backed CompassPort — the real
 * membership authorization (project owner / project_members owner|editor|
 * viewer via the Compass resources tree). The analysisService default is
 * DENY-BY-WIRING (`CompassNotConfigured`), so mounting the router is what
 * turns authorization on; test harnesses may still override the port via
 * `setCompassPort` AFTER the router is built (the wire never re-fires, so a
 * harness override is never clobbered by a later `buildQuiverRouter` call).
 */
export function wireDbCompassPort(): void {
  if (compassWired) return;
  compassWired = true;
  setCompassPort(dbCompassPort);
}

export function buildQuiverRouter(flags: QuiverPhaseFlags = readPhaseFlags()): Router {
  // Boot-time invariant: 26 card types in registry (B2 C-02). Throws on drift.
  assertRegistryIntegrity();
  // Authorization wiring (idempotent — see wireDbCompassPort).
  wireDbCompassPort();
  const r = Router();

  // Bridge globalAuth's verified principal into the actor shape the Quiver
  // routes read. globalAuth (middleware/globalAuth.ts) populates req.user /
  // req.auth from the validated JWT (or TELLUS_TOKEN cookie); the per-route
  // `actorFromReq` helpers, however, look for `req.securityContext.userSubject`
  // — which nothing else in the stack ever sets, so real (non-test) auth would
  // always 401. Derive it here once for every sub-router. In QUIVER_ALLOW_TEST_
  // AUTH mode globalAuth short-circuits before setting req.user, so this no-ops
  // and the existing (token-bound) x-test-user header path still applies.
  r.use((req: Request, _res: Response, next: NextFunction) => {
    const anyReq = req as Request & {
      user?: { id?: string };
      auth?: { sub?: string; orgs?: string[]; organizations?: string[]; orgRid?: string };
      securityContext?: { userSubject?: string; orgRid?: string };
    };
    if (!anyReq.securityContext?.userSubject) {
      const sub = anyReq.user?.id ?? anyReq.auth?.sub;
      if (sub) {
        const org =
          anyReq.auth?.orgRid ??
          anyReq.auth?.orgs?.[0] ??
          anyReq.auth?.organizations?.[0] ??
          "ri.multipass.main.org.default";
        anyReq.securityContext = { userSubject: sub, orgRid: org };
      }
    }
    next();
  });

  if (flags.phase >= 1) {
    r.use(analysesRouter);
    r.use(versionsRouter);
    r.use(registryRouter);
  }
  if (flags.phase >= 2) {
    r.use(computeRouter);
  }
  if (flags.phase >= 3) {
    r.use(instructionsRouter);
  }
  if (flags.phase >= 5) {
    r.use(aipRouter);
    r.use(publishingRouter());
  }
  return r;
}
