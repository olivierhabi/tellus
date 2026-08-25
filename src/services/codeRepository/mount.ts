// ---------------------------------------------------------------------------
// B2 — Mount the Code Repository admin router on the main tellus server.
//
// The standalone `createCodeRepositoryApp` (admin/app.ts) is for tests; the
// main server mounts only the inner router so that the existing globalAuth +
// inputSanitizer + requestLogger stack applies uniformly.
//
// Adapters: the in-memory test adapters are used by default. Production
// deployments swap them out via `mountCodeRepositoryRouter({ ... })`.
// For demo / e2e validation that is sufficient — the saga + ledger + DDL
// path is real, only the upstream Compass / Stemma / Templates calls are
// stubbed deterministically.
//
// `mountCodeRepository` (preferred) returns BOTH the router and the adapter
// instances so the caller can drive boot-time hooks (e.g. the in-memory
// Stemma rehydrator in `rehydrate.ts`) against the same instances the
// router will use at request time.
// ---------------------------------------------------------------------------

import type { Router } from "express";
import type { Pool } from "pg";

import { codeRepositoryRouter } from "./admin/routes";
import {
  InMemoryCompass,
  InMemoryStemma,
  InMemoryTemplate,
} from "./adapters/inMemory";
import type {
  CompassAdapter,
  StemmaAdapter,
  TemplateAdapter,
} from "./adapters/types";
import type { FunctionsPublishService } from "../functionsPublish/service";

export interface MountCodeRepositoryRouterDeps {
  readonly pool: Pool;
  readonly compass?: CompassAdapter;
  readonly stemma?: StemmaAdapter;
  readonly template?: TemplateAdapter;
  readonly functionsPublisher?: FunctionsPublishService;
}

export interface CodeRepositoryAdapters {
  readonly compass: CompassAdapter;
  readonly stemma: StemmaAdapter;
  readonly template: TemplateAdapter;
}

export interface MountCodeRepositoryResult {
  readonly router: Router;
  readonly adapters: CodeRepositoryAdapters;
}

/**
 * Build adapters + router for `app.use("/api/v1/code-repositories", ...)`.
 *
 * Returns both so callers can drive boot-time hooks that need the same
 * adapter instances (e.g. `rehydrateInMemoryStemma`).
 *
 * Routes (resource is the mount path; cf. /api/v1/datasets, /api/v1/projects):
 *   POST   /                                   create repository (saga)
 *   GET    /                                   cursor-paginated list
 *   GET    /:rid                               get repository
 *   PATCH  /:rid                               update (If-Match required)
 *   DELETE /:rid                               soft-delete (If-Match required)
 *   GET    /:rid/branches                      list cached branches
 *   GET    /:rid/branches/:branch/tree         B2-C-10 tree listing
 *   GET    /:rid/branches/:branch/files        B2-C-11 blob read (≤5 MB)
 *   GET    /:rid/settings                      read settings
 *   PUT    /:rid/settings                      update settings (If-Match)
 */
export function mountCodeRepository(deps: MountCodeRepositoryRouterDeps): MountCodeRepositoryResult {
  // Build adapters in dependency order: stemma first, then template
  // (template wires through to stemma.commitFiles to materialize the B3
  // manifest's file list onto the default branch).
  const compass = deps.compass ?? new InMemoryCompass();
  const stemma = deps.stemma ?? new InMemoryStemma();
  const template = deps.template ?? new InMemoryTemplate({ stemma });
  const adapters: CodeRepositoryAdapters = { compass, stemma, template };
  const router = codeRepositoryRouter({
    pool: deps.pool,
    compass: adapters.compass,
    stemma: adapters.stemma,
    template: adapters.template,
    functionsPublisher: deps.functionsPublisher,
  });
  return { router, adapters };
}

/**
 * Backwards-compatible router-only mounter. Discards the adapter handles —
 * use `mountCodeRepository` if you need them.
 */
export function mountCodeRepositoryRouter(deps: MountCodeRepositoryRouterDeps): Router {
  return mountCodeRepository(deps).router;
}
