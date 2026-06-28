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
import { getActionType } from "../models/actionType";
import type { ActionTypeRow } from "../models/actionType";
import { validateParameters } from "./parameterValidator";
import type { ParameterDefinition } from "./parameterValidator";
import { compileRules } from "./ruleCompiler";
import type { CompiledEdit } from "./ruleCompiler";
import { evaluateSubmissionCriteria, type SubmissionSubject } from "./submissionCriteria";
import { getIndexName } from "../services/opensearch/indexMappingGenerator";
import { client as opensearchClient } from "../services/opensearch/client";

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
// OpenSearch helpers (duplicated from actionExecutor to keep this module
// independent — the spec requires a separate function, not reusing the
// executor)
// ---------------------------------------------------------------------------

/**
 * Check if an object exists in OpenSearch. Used as the objectExistsChecker
 * for parameter validation (object_reference type parameters).
 */
async function objectExists(
  objectType: string,
  primaryKey: string
): Promise<boolean> {
  try {
    const indexName = getIndexName(objectType);
    await opensearchClient.get({ index: indexName, id: primaryKey });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch an object from OpenSearch. Used as the objectFetcher for rule
 * compilation (modifyObject/deleteObject rules need the current state).
 * Returns the document _source, or null if not found.
 */
async function fetchObject(
  objectType: string,
  primaryKey: string
): Promise<Record<string, unknown> | null> {
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
  context?: { executedBy?: string; roles?: string[]; groups?: string[] }
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

  if (!actionType.is_enabled) {
    return {
      valid: false,
      errors: [`Action type '${actionTypeApiName}' is disabled`],
    };
  }

  // -----------------------------------------------------------------
  // STAGE 2: Validate parameters
  // -----------------------------------------------------------------
  const validation = await validateParameters(
    actionType.parameters as ParameterDefinition[],
    parameters,
    objectExists
  );

  if (!validation.valid) {
    return { valid: false, errors: validation.errors };
  }

  const resolvedParameters = validation.resolvedParameters!;

  // -----------------------------------------------------------------
  // STAGE 3: Submission criteria
  // -----------------------------------------------------------------
  const subject: SubmissionSubject = {
    username: context?.executedBy ?? undefined,
    roles: [],
    groups: [],
  };

  const submission = evaluateSubmissionCriteria(
    actionType.submission_criteria,
    resolvedParameters as Record<string, unknown>,
    subject,
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
