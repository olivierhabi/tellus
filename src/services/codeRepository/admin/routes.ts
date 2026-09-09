// ---------------------------------------------------------------------------
// B2 — Code Repository Service HTTP routes.
//
// Mounts under /api/v1/code-repositories (live) or /api/v1/code-repositories
// in the standalone test app. The mount-path-as-resource convention follows
// the rest of /api/docs/* (datasets, projects, templates, …).
//
// This module is the composition root only: every route group lives in its
// own router factory under ./routers/ (repos, branches, drafts,
// chat-sessions, tree, commits, settings, tags, functions, function-invoke)
// with shared helpers in ./routeHelpers.ts and the shared context in
// ./routeContext.ts. Sub-routers are mounted in the original registration
// order; all route patterns are disjoint (segment count / method), so the
// split preserves matching behaviour exactly.
//
// Cross-cutting:
//   - Bearer auth (G-C-07..11)  via requireCodeReposAuth (per-route, ADR-008)
//   - Idempotency-Key on POST   via idempotencyMiddleware
//   - ETag/If-Match on PATCH/PUT/DELETE
//   - Audit row per mutating call (G-C-51..54) inside the same tx
//   - §1.3 envelope on every error path
//   - IDOR-as-404 (G-C-09)
// ---------------------------------------------------------------------------

import { Router } from "express";
import {
  createRouteContext,
  type CodeRepositoryRoutesDeps,
} from "./routeContext";
import { createReposRouter } from "./routers/reposRouter";
import { createBranchesRouter } from "./routers/branchesRouter";
import { createDraftsRouter } from "./routers/draftsRouter";
import { createChatSessionsRouter } from "./routers/chatSessionsRouter";
import { createSettingsRouter } from "./routers/settingsRouter";
import { createTagsRouter } from "./routers/tagsRouter";
import { createFunctionsRouter } from "./routers/functionsRouter";
import { createFunctionInvokeRouter } from "./routers/functionInvokeRouter";
import { createTreeRouter } from "./routers/treeRouter";
import { createCommitsRouter } from "./routers/commitsRouter";

export type { CodeRepositoryRoutesDeps };

export function codeRepositoryRouter(deps: CodeRepositoryRoutesDeps): Router {
  const router = Router();
  const routeCtx = createRouteContext(deps);

  // Repository CRUD (POST / GET / GET|PATCH|DELETE /:rid).
  router.use(createReposRouter(routeCtx));

  // Branch list/create/delete.
  router.use(createBranchesRouter(routeCtx));

  // Drafts + chat sessions.
  router.use(createDraftsRouter(routeCtx));
  router.use(createChatSessionsRouter(routeCtx));

  // Tree/blob reads + commits.
  router.use(createTreeRouter(routeCtx));
  router.use(createCommitsRouter(routeCtx));

  // Settings + resource-imports.
  router.use(createSettingsRouter(routeCtx));

  // Tag & Release.
  router.use(createTagsRouter(routeCtx));

  // Functions listing + function invoke.
  router.use(createFunctionsRouter(routeCtx));
  router.use(createFunctionInvokeRouter(routeCtx));

  return router;
}
