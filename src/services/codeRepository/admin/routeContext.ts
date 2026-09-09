// ---------------------------------------------------------------------------
// Shared context for the code-repository admin sub-routers.
//
// routes.ts (the god-file breakup) splits the 25 route handlers into
// per-group router factories under ./routers/. Every factory takes this
// context instead of closing over the parent builder's locals, so the
// sub-routers share one auth-middleware instance and one saga-deps object —
// exactly like the original single-builder shape.
//
// Auth scoping (ADR-008): auth stays per-route (`auth` below), NOT
// `router.use(requireCodeReposAuth())` — router-level auth combined with
// parent-prefix mounting would intercept sibling /api/v1/* routes.
// ---------------------------------------------------------------------------

import type { Pool } from "pg";
import type { NextFunction, Request, Response } from "express";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal";
import type {
  CompassAdapter,
  StemmaAdapter,
  TemplateAdapter,
} from "../adapters/types";
import type { FunctionsPublishService } from "../../functionsPublish/service";
import type { SagaExecutorDeps } from "../saga/executor";

export interface CodeRepositoryRoutesDeps {
  readonly pool: Pool;
  readonly compass: CompassAdapter;
  readonly stemma: StemmaAdapter;
  readonly template: TemplateAdapter;
  readonly functionsPublisher?: FunctionsPublishService;
}

export interface CodeRepositoryRouteContext {
  readonly pool: Pool;
  readonly compass: CompassAdapter;
  readonly stemma: StemmaAdapter;
  readonly template: TemplateAdapter;
  readonly functionsPublisher?: FunctionsPublishService;
  readonly sagaDeps: SagaExecutorDeps;
  /** Shared per-route auth middleware instance (ADR-008). */
  readonly auth: (req: Request, res: Response, next: NextFunction) => void;
}

export function createRouteContext(deps: CodeRepositoryRoutesDeps): CodeRepositoryRouteContext {
  return {
    pool: deps.pool,
    compass: deps.compass,
    stemma: deps.stemma,
    template: deps.template,
    functionsPublisher: deps.functionsPublisher,
    sagaDeps: {
      pool: deps.pool,
      compass: deps.compass,
      stemma: deps.stemma,
      template: deps.template,
    },
    auth: requireCodeReposAuth(),
  };
}
