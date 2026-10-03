// ---------------------------------------------------------------------------
// Action Validator (Dry Run)
//
// Runs the action execution pipeline WITHOUT applying edits. This is the
// backend for the /validate endpoint, which lets UIs preview what an action
// will do before committing. In Palantir, Workshop's action forms use this
// to show validation errors in real-time as the user fills in parameters,
// and to preview affected objects before the user clicks "Submit".
//
// This is a SEPARATE function from executeAction — it does NOT reuse
// executeAction with a flag. It runs only:
//
//   Stage 1: Load the action type definition
//   Stage 2: Validate parameters
//   Stage 3: Submission criteria (evaluateSubmissionCriteria)
//   Stage 4: Compile rules into edits
//
// Stage 6 (edit application), Stage 7 (side effects), and Stage 8 (audit
// logging) are intentionally skipped — this is a dry run.
// ---------------------------------------------------------------------------

import { query } from "../db";
import { getOntologyId } from "../services/ontology/canonicalOntology";
import { getActionType, resolveSemanticsForRow } from "../models/actionType";
import type { ActionTypeRow } from "../models/actionType";
import { validateParameters } from "./parameterValidator";
import type { ParameterDefinition } from "./parameterValidator";
import { compileRules } from "./ruleCompiler";
import type { CompiledEdit } from "./ruleCompiler";
import {
  collectAttachmentRidsFromEdits,
  verifyAttachmentReferences,
} from "../services/attachmentService";
import { evaluateSubmissionCriteria, resolveObjectPropertyOperands, type SubmissionSubject } from "./submissionCriteria";
import { getIndexName } from "../services/opensearch/indexMappingGenerator";
import { client as opensearchClient } from "../services/opensearch/client";
import { OntologyError } from "../utils/queryErrors";
import { getActionSemanticsExecutionAvailability } from "./actionSemanticsFlags";
import { getKeycloakAdminService } from "../services/keycloakAdminService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single edit preview entry. */
export interface EditPreview {
  objectType: string;
  primaryKey: string;
  operation: "create" | "update" | "delete";
  properties: string[];
}

/** Successful validation result with a preview. */
export interface ValidationSuccess {
  valid: true;
  errors: [];
  preview: {
    affectedObjectCount: number;
    edits: EditPreview[];
  };
}

/** Failed validation result with errors. */
export interface ValidationFailure {
  valid: false;
  errors: string[];
}

/** Union of all possible validation results. */
export type ValidationResult = ValidationSuccess | ValidationFailure;

// ---------------------------------------------------------------------------
// Default ontology helper
// ---------------------------------------------------------------------------

/**
 * Get the single enterprise ontology ID. "One Enterprise, One Ontology" — this
 * delegates to the canonical resolver so every caller agrees on the same id.
 * Returns null only when no ontology exists at all (pre-bootstrap).
 */
export async function getDefaultOntologyId(): Promise<string | null> {
  return getOntologyId();
}

// ---------------------------------------------------------------------------
// Object-state helpers (duplicated from actionExecutor to keep this module
// independent — the spec requires a separate function, not reusing the
// executor).
//
// LOCKSTEP INVARIANT: the READ STRATEGY must stay identical to
// actionExecutor.ts — Postgres-first (`object_instances` is the
// authoritative writeback store), OpenSearch only as the fallback for
// objects that predate the writeback store. A serving-only read here makes
// /validate approve submissions that /apply then rejects on live state
// (observed: rssbOpenFraudCase validate=valid on a signal whose store
// status was DISMISSED while the serving projection still read OPEN).
// ---------------------------------------------------------------------------

/**
 * Check if an object exists. Used as the objectExistsChecker for parameter
 * validation (object_reference type parameters). PG-first so a
 * freshly-created object (committed in the same or a preceding action txn)
 * is visible without waiting for serving-index projection.
 */
async function objectExists(
  objectType: string,
  primaryKey: string
): Promise<boolean> {
  try {
    const res = await query(
      `SELECT 1 FROM object_instances
        WHERE object_type_api_name = $1 AND primary_key = $2
        LIMIT 1`,
      [objectType, primaryKey]
    );
    if ((res.rowCount ?? 0) > 0) return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Tolerate missing B1 table in transitional deployments; fall through.
    if (!/relation .*object_instances.* does not exist/i.test(msg)) {
      console.warn(`[validate:objectExists] PG lookup failed: ${msg}`);
    }
  }

  try {
    const indexName = getIndexName(objectType);
    await opensearchClient.get({ index: indexName, id: primaryKey });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch an object's CURRENT state. Used as the objectFetcher for rule
 * compilation + submission-criteria live-object operands. PG-first for the
 * same reason as objectExists — /validate must evaluate exactly the state
 * /apply will enforce.
 */
async function fetchObject(
  objectType: string,
  primaryKey: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await query(
      `SELECT properties FROM object_instances
        WHERE object_type_api_name = $1 AND primary_key = $2
        LIMIT 1`,
      [objectType, primaryKey]
    );
    if ((res.rowCount ?? 0) > 0) {
      const row = res.rows[0] as { properties: unknown };
      if (row.properties && typeof row.properties === "object") {
        return row.properties as Record<string, unknown>;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/relation .*object_instances.* does not exist/i.test(msg)) {
      console.warn(`[validate:fetchObject] PG lookup failed: ${msg}`);
    }
  }

  try {
    const indexName = getIndexName(objectType);
    const { body } = await opensearchClient.get({
      index: indexName,
      id: primaryKey,
    });
    return (body as any)._source ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Validates an action without applying edits (dry run). Runs Stages 1, 2,
 * and 4 of the execution pipeline and returns either a preview of what the
 * action would do, or a list of validation errors.
 *
 * @param ontologyId        - The ontology ID
 * @param actionTypeApiName - The api_name of the action type to validate
 * @param parameters        - The raw parameters provided by the caller
 * @param context           - Optional execution context (executedBy)
 * @returns ValidationResult — { valid, errors, preview? }
 */
export async function validateAction(
  ontologyId: string,
  actionTypeApiName: string,
  parameters: Record<string, unknown>,
  context?: {
    executedBy?: string;
    /** Canonical external principal ID used by currentUserId parameter bindings. */
    currentUserId?: string;
    /** Authenticated username/email used by `Current User · username` criteria. */
    currentUsername?: string;
    roles?: string[];
    groups?: string[];
    organizations?: string[];
    executionContext?: string;
  }
): Promise<ValidationResult> {
  // -----------------------------------------------------------------
  // STAGE 1: Load the action type definition
  // -----------------------------------------------------------------
  const actionType: ActionTypeRow | null = await getActionType(
    ontologyId,
    actionTypeApiName
  );

  if (!actionType) {
    return { valid: false, errors: ["Action type not found"] };
  }

  // Foundry parity: `is_enabled` is cosmetic and never gates validation.
  // Webhook lifecycle safety remains at apply time (writeback executor
  // refuses non-active webhooks; failurePolicy 'abort' halts before edits).

  // -----------------------------------------------------------------
  // STAGE 1b: Action semantics availability
  //
  // Validation and execution intentionally share the same rollout decision.
  // Returning a successful preview for an action that apply must reject is a
  // broken API contract and causes late, confusing submission failures.
  // -----------------------------------------------------------------
  const semantics = resolveSemanticsForRow({
    semantics_version: actionType.semantics_version,
    execution_mode: actionType.execution_mode,
    delete_policy: actionType.delete_policy,
  });
  const semanticsAvailability =
    getActionSemanticsExecutionAvailability(semantics.semanticsVersion);
  if (!semanticsAvailability.available) {
    throw new OntologyError(
      semanticsAvailability.message ??
        `Unsupported action semantics version '${semantics.semanticsVersion}'.`,
      semanticsAvailability.code ?? "UNSUPPORTED_SEMANTICS_VERSION",
      422,
      semanticsAvailability.details ?? {
        semanticsVersion: semantics.semanticsVersion,
      },
    );
  }

  // -----------------------------------------------------------------
  // STAGE 2: Validate parameters
  // -----------------------------------------------------------------
  const validation = await validateParameters(
    actionType.parameters as ParameterDefinition[],
    parameters,
    objectExists,
    fetchObject,
    {
      currentUserId: context?.currentUserId ?? context?.executedBy,
      userExists: async (userId) => {
        const user = await getKeycloakAdminService().getUserById(userId);
        return user?.enabled === true;
      },
    },
  );

  if (!validation.valid) {
    return { valid: false, errors: validation.errors };
  }

  const resolvedParameters = validation.resolvedParameters!;

  // -----------------------------------------------------------------
  // STAGE 3: Submission criteria
  // -----------------------------------------------------------------
  const subject: SubmissionSubject = {
    username: context?.currentUsername ?? context?.executedBy ?? undefined,
    userId: context?.currentUserId ?? undefined,
    // Role/group predicates must use the caller's identity, same as
    // actionExecutor.ts Stage 3 — otherwise /validate rejects every
    // role-gated action that /apply would accept.
    roles: context?.roles ?? [],
    groups: context?.groups ?? [],
    // Same subject fields the executor's Stage 3 uses, for the same reason:
    // /validate must accept exactly what /apply would, or an org-gated or
    // scenario-gated action fails pre-flight and succeeds on submit.
    organizations: context?.organizations ?? [],
    executionContext: context?.executionContext ?? undefined,
  };

  // D27 — pre-resolve object-property operands against the live referenced-
  // object state before evaluating criteria (same path as the executor).
  const objectPropertyValues = await resolveObjectPropertyOperands(
    actionType.submission_criteria,
    resolvedParameters as Record<string, unknown>,
    actionType.parameters as ReadonlyArray<{ apiName: string; objectType?: string }>,
    fetchObject,
  );
  const submission = evaluateSubmissionCriteria(
    actionType.submission_criteria,
    resolvedParameters as Record<string, unknown>,
    subject,
    objectPropertyValues,
  );

  if (!submission.ok) {
    return {
      valid: false,
      errors: [`Submission criteria not met: ${submission.failures.join("; ")}`],
    } as ValidationFailure;
  }

  // -----------------------------------------------------------------
  // STAGE 4: Compile rules into edits
  // -----------------------------------------------------------------
  const compilation = await compileRules(
    actionType.rules as any[],
    resolvedParameters,
    fetchObject,
    {
      executedBy: context?.executedBy || "system",
      ontologyId,
      previewGeneratedSequences: true,
    }
  );

  if (compilation.errors.length > 0) {
    return { valid: false, errors: compilation.errors };
  }

  // Check scale limit
  if (compilation.affectedObjectCount > actionType.max_affected_objects) {
    return {
      valid: false,
      errors: [
        `Would affect ${compilation.affectedObjectCount} objects (limit: ${actionType.max_affected_objects})`,
      ],
    };
  }

  // Attachment reference verification (Foundry upload-attachments parity —
  // same gate as the submit path, so validate predicts apply).
  const attachmentRids = collectAttachmentRidsFromEdits(compilation.edits);
  if (attachmentRids.length > 0) {
    const attachmentCheck = await verifyAttachmentReferences(attachmentRids);
    const attachmentErrors: string[] = [];
    for (const rid of attachmentCheck.missing) {
      attachmentErrors.push(
        `Attachment '${rid}' does not exist or is no longer available. ` +
          `Upload the file again and resubmit.`,
      );
    }
    for (const over of attachmentCheck.overLinked) {
      attachmentErrors.push(
        `Attachment '${over.rid}' is already linked to ${over.linkedObjects} object(s) ` +
          `(limit 10). Upload the file again as a new attachment to link it further.`,
      );
    }
    if (attachmentErrors.length > 0) {
      return { valid: false, errors: attachmentErrors };
    }
  }

  // -----------------------------------------------------------------
  // SUCCESS: Return preview (NO edits applied — this is a dry run)
  // -----------------------------------------------------------------
  return {
    valid: true,
    errors: [] as [],
    preview: {
      affectedObjectCount: compilation.affectedObjectCount,
      edits: compilation.edits.map(
        (e: CompiledEdit): EditPreview => ({
          objectType: e.objectType,
          primaryKey: e.primaryKey,
          operation: e.operation,
          properties:
            e.operation !== "delete"
              ? Object.keys(e.propertyValues || {})
              : [],
        })
      ),
    },
  };
}

export default { validateAction, getDefaultOntologyId };
