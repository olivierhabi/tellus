// ---------------------------------------------------------------------------
// Action Type Routes
//
// CRUD REST API endpoints for managing action type definitions in the
// Ontology. Action types define parameterized, auditable sets of changes
// that can be applied to objects, properties, and links.
//
// Mounted at: /api/v1/ontology/:ontologyId/actionTypes
//
// Endpoints:
//   POST   /                                  — Create a new action type        (./create)
//   GET    /                                  — List action types               (./list)
//   GET    /by-rid/:rid                       — Get by RID                      (./list)
//   POST   /by-rid/batch                      — Get by RIDs (batch)             (./list)
//   GET    /:actionApiName                    — Get single action type          (./list)
//   PUT|PATCH /:actionApiName                 — Update                          (./update)
//   POST   /:actionApiName/blastRadius        — Pre-save blast radius preview   (./update)
//   POST   /:actionApiName/clone              — Clone (Task 23)                 (./clone)
//   GET    /:actionApiName/impact             — Impact analysis (Task 24)       (./impact)
//   GET    /:actionApiName/migrationAnalysis  — v1→v2 migration analysis        (./migrate)
//   POST   /:actionApiName/migrate            — Semantics migration             (./migrate)
//   POST   /:actionApiName/migrate/rollback   — Migration rollback              (./migrate)
//   DELETE /:actionApiName                    — Delete                          (./delete)
//
// NOTE: registration order below MUST match the historical single-file order
// (Express matches in registration order — e.g. /by-rid/batch must register
// before /:actionApiName/clone).
// ---------------------------------------------------------------------------

import { Router } from "express";
import { dataPlaneGuard } from "../../middleware/requireRole";
import { registerCreateRoutes } from "./create";
import { registerListRoutes } from "./list";
import { registerUpdateRoutes } from "./update";
import { registerCloneRoutes } from "./clone";
import { registerImpactRoutes } from "./impact";
import { registerMigrateRoutes } from "./migrate";
import { registerDeleteRoutes } from "./delete";

const router = Router({ mergeParams: true });

// Function-level authorization: action-type create/update/clone require
// ontology-editor, delete requires ontology-admin (PATs scope-gated upstream,
// superadmin passes, reads open).
router.use(dataPlaneGuard({ post: "write" }));

registerCreateRoutes(router);
registerListRoutes(router);
registerUpdateRoutes(router);
registerCloneRoutes(router);
registerImpactRoutes(router);
registerMigrateRoutes(router);
registerDeleteRoutes(router);

// Public API surface preserved for existing importers (server.ts, unit tests).
export {
  ACTION_PARAMETER_RID_PREFIX,
  ACTION_RULE_RID_PREFIX,
  ACTION_RULE_SCHEMA_VERSION,
  ensureParameterRids,
  ensureRuleRids,
  formatActionType,
  resolveWebhookOutputPath,
} from "./shared";

export default router;
