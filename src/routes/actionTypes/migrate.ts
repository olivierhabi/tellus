// ---------------------------------------------------------------------------
// Action Type Routes — Semantics Migration
//
// GET /:actionApiName/migrationAnalysis, POST /:actionApiName/migrate, POST /:actionApiName/migrate/rollback.
// Extracted from the former god-file routes/actionTypes.ts (behavior-preserving
// move; route registration order is unchanged — see ./index.ts).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { getActionType, migrateActionTypeSemantics, migrateActionTypeWithDefinition, rollbackActionTypeMigration } from "../../models/actionType";
import { sendError, sendSuccess } from "../../utils/responseFormatter";
import { OntologyError } from "../../utils/queryErrors";
import { getActionSemanticsExecutionAvailability } from "../../actions/actionSemanticsFlags";
import { analyzeActionTypeMigration, ACKNOWLEDGEMENT_REQUIRED_FINDING_CODES, MigrationFinding, MigrationReport } from "../../actions/actionMigrationAnalysis";
import { hashActionDefinition } from "../../actions/actionDefinitionHash";
import { defaultSchemaLookup } from "../../actions/objectReferenceResolver";
import { recordMigration } from "../../models/actionMigrationLog";
import { resolveSemanticsForRow } from "../../models/actionType";
import {
  KNOWN_CODES,
  formatActionType,
  actorOf,
  currentDefinitionHashFor,
} from "./shared";

export function registerMigrateRoutes(router: Router): void {
// ---------------------------------------------------------------------------
// Endpoint: GET /:actionApiName/migrationAnalysis (§12)
//
// Returns a v1→v2 migration analysis for the action type: classification,
// proposed Assurf definition with typed object_reference parameters,
// per-parameter migration details (primary-key base type loaded from the
// object schema), wire compatibility, mixed-usage detection, delete-policy
// impact, acknowledgement-required finding codes, and a definition hash the
// client must echo back on /migrate for optimistic concurrency. Static
// analysis only — never migrates.
// ---------------------------------------------------------------------------
router.get(
  "/:actionApiName/migrationAnalysis",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;
      const row = await getActionType(ontologyId, actionApiName);
      if (!row) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND", undefined, { actionTypeApiName: actionApiName, ontologyId },
        );
      }
      const semantics = resolveSemanticsForRow({
        semantics_version: (row as any).semantics_version ?? null,
        execution_mode: (row as any).execution_mode ?? null,
        delete_policy: (row as any).delete_policy ?? null,
      });
      const report: MigrationReport = await analyzeActionTypeMigration(
        {
          rules: (row.rules ?? []) as any[],
          parameters: (row.parameters ?? []) as any[],
        },
        { schemaLookup: defaultSchemaLookup, ontologyId },
      );
      const currentDefinitionHash = hashActionDefinition({
        parameters: row.parameters,
        rules: row.rules,
        semanticsVersion: semantics.semanticsVersion,
        executionMode: semantics.executionMode,
        deletePolicy: semantics.deletePolicy,
      });
      const rolloutAvailability =
        getActionSemanticsExecutionAvailability(2);
      const migrationPermitted =
        rolloutAvailability.available &&
        semantics.semanticsVersion === 1 &&
        (report.classification === "compatible" ||
          report.classification === "requires_review") &&
        !!report.proposedDefinition;
      const acknowledgementRequired = report.findings
        .filter((f) =>
          ACKNOWLEDGEMENT_REQUIRED_FINDING_CODES.has(f.code as MigrationFinding["code"]),
        )
        .map((f) => f.code);
      try {
        const { incCounter } = await import("../../services/funnel/metrics");
        incCounter("tellus_action_migration_analysis_total", { classification: report.classification });
      } catch { /* metrics non-blocking */ }
      sendSuccess(res, {
        currentSemanticsVersion: semantics.semanticsVersion,
        proposedTargetVersion: 2,
        classification: report.classification,
        findings: report.findings,
        parameterMigrations: report.parameterMigrations,
        proposedDefinition: report.proposedDefinition,
        schemaVerified: report.schemaVerified,
        deletePolicyChange: report.deletePolicyChange ?? null,
        deletePolicyImpact:
          report.deletePolicyChange === "legacy_unchecked_to_restrict"
            ? "Migration changes the delete policy from legacy_unchecked to restrict; any execution targeting an object with active relationships will be rejected."
            : "No delete-policy change implied by this migration.",
        currentDefinitionHash,
        acknowledgementRequired,
        migrationPermitted,
        rolloutAvailability,
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) return sendError(res, err.code, err.message, err.details);
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Endpoint: POST /:actionApiName/migrate (§12)
//
// Explicit v1→v2 migration. Two accepted request shapes:
//
//   1. Full schema-aware migration (recommended). The client echoes the
//      `currentDefinitionHash` it received from /migrationAnalysis along
//      with the acknowledged finding codes. The server re-derives the
//      proposed definition, rejects stale hashes, requires acknowledgements
//      for review-required findings, persists the new parameters + rules +
//      semantics atomically inside a single transaction, and writes an
//      immutable action_migration_log ledger row.
//
//   2. Legacy semantics-only migration. The client sends only
//      `{ targetVersion: 2 }`. The server refuses unless the action is
//      already classified `compatible` with NO proposed-definition change
//      (i.e. all parameters were already typed object_reference). This
//      preserves the original contract for already-typed actions.
// ---------------------------------------------------------------------------
router.post(
  "/:actionApiName/migrate",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;
      const body = req.body || {};
      if (body.targetVersion !== 2) {
        sendError(res, "VALIDATION_FAILED", "Migration requires targetVersion: 2 (explicit, no automatic downgrade).");
        return;
      }
      const rolloutAvailability =
        getActionSemanticsExecutionAvailability(2);
      if (!rolloutAvailability.available) {
        throw new OntologyError(
          rolloutAvailability.message ??
            "Version-2 action execution is not available for this deployment.",
          rolloutAvailability.code ?? "UNSUPPORTED_SEMANTICS_VERSION",
          422,
          rolloutAvailability.details ?? { semanticsVersion: 2 },
        );
      }
      const actor = actorOf(req);
      const correlationId =
        (req as any).correlationId ??
        ((req as any).requestId ?? null) ??
        null;

      const row = await getActionType(ontologyId, actionApiName);
      if (!row) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND", undefined, { actionTypeApiName: actionApiName, ontologyId },
        );
      }
      const previous = resolveSemanticsForRow({
        semantics_version: (row as any).semantics_version ?? null,
        execution_mode: (row as any).execution_mode ?? null,
        delete_policy: (row as any).delete_policy ?? null,
      });
      if (previous.semanticsVersion !== 1) {
        sendError(res, "INCOMPATIBLE_ACTION_SEMANTICS",
          `Action type is already semantics version ${previous.semanticsVersion}; migration is v1→v2 only.`,
          { currentVersion: previous.semanticsVersion });
        return;
      }

      // Full schema-aware migration path.
      if (typeof body.expectedDefinitionHash === "string" && body.expectedDefinitionHash.length > 0) {
        const result = await migrateActionTypeWithDefinition(ontologyId, actionApiName, {
          expectedDefinitionHash: body.expectedDefinitionHash,
          proposedDefinition: body.proposedDefinition ?? { parameters: row.parameters, rules: row.rules },
          acknowledgedFindingCodes: Array.isArray(body.acknowledgedFindingCodes) ? body.acknowledgedFindingCodes : [],
          adapterEnabled: !!body.adapterEnabled,
          actor,
          correlationId,
        });
        sendSuccess(res, {
          ...formatActionType(result.migrated),
          migrationRecord: {
            actor,
            migratedAt: new Date().toISOString(),
            previousVersion: 1,
            newVersion: 2,
            migrationId: result.log.migration_id,
            previousDefinitionHash: result.log.previous_definition_hash,
            resultingDefinitionHash: result.log.resulting_definition_hash,
            acknowledgedFindingCodes: result.log.acknowledged_finding_codes,
            parameterMigrations: result.log.parameter_changes,
            rollbackAvailable: true,
          },
        });
        return;
      }

      // Legacy semantics-only path: refuse if any proposed-definition change
      // was required (i.e. untyped parameters must be converted). The
      // operator must use the full path.
      const report = await analyzeActionTypeMigration(
        { rules: (row.rules ?? []) as any[], parameters: (row.parameters ?? []) as any[] },
        { schemaLookup: defaultSchemaLookup, ontologyId },
      );
      if (report.parameterMigrations.length > 0 || report.classification !== "compatible") {
        sendError(res, "INCOMPATIBLE_ACTION_SEMANTICS",
          `Migration rejected: this action requires the full migration workflow (expectedDefinitionHash + acknowledgements). Classification '${report.classification}' with ${report.parameterMigrations.length} parameter conversion(s).`,
          { classification: report.classification, parameterMigrations: report.parameterMigrations, findings: report.findings });
        return;
      }
      const migrated = await migrateActionTypeSemantics(ontologyId, actionApiName, 2);
      if (!migrated) {
        throw new OntologyError("Action type not found during migration", "ACTION_TYPE_NOT_FOUND", 404);
      }
      // Record an audit ledger row for the legacy path as well so every
      // v1→v2 migration is tamper-evident and rollback is available. The
      // parameters/rules did NOT change in this path (only the semantics
      // triple), so the previous + resulting snapshots share the same
      // parameters/rules and differ only by the semantics triple.
      const resultingSemantics = resolveSemanticsForRow({
        semantics_version: (migrated as any).semantics_version ?? null,
        execution_mode: (migrated as any).execution_mode ?? null,
        delete_policy: (migrated as any).delete_policy ?? null,
      });
      const previousHash = currentDefinitionHashFor(row, previous);
      const resultingHash = hashActionDefinition({
        parameters: migrated.parameters,
        rules: migrated.rules,
        semanticsVersion: resultingSemantics.semanticsVersion,
        executionMode: resultingSemantics.executionMode,
        deletePolicy: resultingSemantics.deletePolicy,
      });
      let legacyMigrationId: string | undefined;
      try {
        const audit = await recordMigration({
          ontologyId,
          actionApiName,
          migrationKind: "migrate",
          previousSemanticsVersion: 1,
          resultingSemanticsVersion: 2,
          previousDeletePolicy: previous.deletePolicy,
          resultingDeletePolicy: resultingSemantics.deletePolicy,
          previousDefinitionHash: previousHash,
          resultingDefinitionHash: resultingHash,
          previousDefinitionSnapshot: {
            parameters: row.parameters,
            rules: row.rules,
            semanticsVersion: 1,
            executionMode: previous.executionMode,
            deletePolicy: previous.deletePolicy,
          },
          resultingDefinitionSnapshot: {
            parameters: migrated.parameters,
            rules: migrated.rules,
            semanticsVersion: 2,
            executionMode: resultingSemantics.executionMode,
            deletePolicy: resultingSemantics.deletePolicy,
          },
          parameterChanges: [],
          acknowledgedFindingCodes: [],
          adapterEnabled: false,
          actor,
          correlationId,
        });
        legacyMigrationId = audit.migration_id;
      } catch (auditErr: any) {
        // The action_type migration already committed; the audit ledger
        // insert failed. Surface the audit failure but DO NOT undo the
        // committed migration.
        console.error("legacy-migrate audit row write failed:", auditErr?.message);
      }
      sendSuccess(res, {
        ...formatActionType(migrated),
        migrationRecord: {
          actor,
          migratedAt: new Date().toISOString(),
          previousVersion: 1,
          newVersion: 2,
          migrationId: legacyMigrationId,
          previousDefinitionHash: previousHash,
          resultingDefinitionHash: resultingHash,
          rollbackAvailable: !!legacyMigrationId,
        },
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) return sendError(res, err.code, err.message, err.details);
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Endpoint: POST /:actionApiName/migrate/rollback (§12)
//
// Restores the previous v1 definition from the latest forward migration's
// immutable `previous_definition_snapshot`. Append-only: writes a NEW
// `rollback` ledger row inside the same transaction. The action_type UPDATE
// goes through the same domain path (parameters/rules/semantics columns in
// a single transactional UPDATE) — never a raw row patch.
//
// IMPORTANT: rolling back the definition does NOT reverse any object
// mutations already produced by executions that ran under v2 semantics.
// ---------------------------------------------------------------------------
router.post(
  "/:actionApiName/migrate/rollback",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;
      const actor = actorOf(req);
      const correlationId =
        (req as any).correlationId ?? ((req as any).requestId ?? null) ?? null;
      const result = await rollbackActionTypeMigration(
        ontologyId,
        actionApiName,
        actor,
        correlationId,
      );
      sendSuccess(res, {
        ...formatActionType(result.rolledBack),
        rollbackRecord: {
          actor,
          rolledBackAt: new Date().toISOString(),
          previousVersion: 2,
          newVersion: result.log.resulting_semantics_version,
          restoredFromMigrationId: result.log.previous_definition_hash,
          migrationLogId: result.log.migration_id,
          note: "Definition rollback does not revert object mutations already produced by executions under v2 semantics.",
        },
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) return sendError(res, err.code, err.message, err.details);
      next(err);
    }
  },
);
}
