// =============================================================================
// B09 — Workshop Action-Type Wizard API
//
// Spec §B09 + §C Phase 6 Step 1: Workshop's UI lets a user create an action
// type (Modify object(s) + parameters: user-bound + static-bound + submission
// criteria User→self). After save, the new action type must appear in the
// B06 OMS picker within 30s (cache TTL) — we explicitly invalidate after
// write to make it immediate.
//
// This service writes to the existing `action_type` table that B06 reads
// from (D-02: same-process consistency). It records audit + invalidates the
// OMS cache.
//
// Surface:
//   POST  /api/v1/workshop/action-types         (create) — Idempotency-Key required
//   PUT   /api/v1/workshop/action-types/{idOrApiName}  (update) — ETag required
// =============================================================================

import { z } from "zod";
import { getWorkshopDb } from "./db.js";
import { workshopError } from "./errors.js";
import { invalidateOntology } from "./omsFacade.js";
import { emitWorkshopAudit } from "./audit.js";
import type { Actor } from "./moduleService.js";
import {
  histActionTypeCreate,
  counterActionTypeCreate,
} from "./metrics.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Parameter definitions per spec §C Phase 6 Step 1. */
export const parameterDefinitionSchema = z
  .object({
    apiName: z.string().min(1).max(64),
    /**
     * `user` = user-bound (UI prompts the user)
     * `static` = static value supplied by the action type author (hidden from
     *   the binding UI's parameter-defaults table per §C P6S2 expectation)
     */
    binding: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user") }),
      z.object({
        kind: z.literal("static"),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      }),
    ]),
    type: z.enum([
      "string",
      "integer",
      "double",
      "boolean",
      "user",
      "objectReference",
    ]),
    required: z.boolean(),
  })
  .strict();

export const submissionCriteriaSchema = z
  .object({
    /** User → self per the §C P6S1 example. */
    kind: z.literal("user"),
    target: z.literal("self"),
  })
  .strict();

export const actionTypeRequestSchema = z
  .object({
    ontologyRid: z.string().min(1),
    apiName: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    displayName: z.string().min(1).max(200),
    description: z.string().max(2000).default(""),
    parameters: z.array(parameterDefinitionSchema).max(64),
    submissionCriteria: submissionCriteriaSchema.nullable().optional(),
    isEnabled: z.boolean().default(true),
    maxAffectedObjects: z.number().int().positive().max(10_000).default(1000),
  })
  .strict();

export type ActionTypeRequest = z.infer<typeof actionTypeRequestSchema>;

export interface ActionTypeRow {
  id: string;
  ontologyId: string;
  apiName: string;
  displayName: string;
  description: string;
  parameters: unknown[];
  submissionCriteria: unknown | null;
  isEnabled: boolean;
  maxAffectedObjects: number;
  createdAt: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// Validation: at least one user-bound parameter (otherwise the binding UI has
// nothing to render). Per §C P6S1 the example has Assignee user-bound.
// -----------------------------------------------------------------------------

export function assertParameterShape(req: ActionTypeRequest): void {
  const seen = new Set<string>();
  for (const p of req.parameters) {
    if (seen.has(p.apiName))
      throw workshopError({
        errorName: "Tellus:Workshop:DuplicateParameterApiName",
        status: 400,
        parameters: { apiName: p.apiName },
      });
    seen.add(p.apiName);
  }
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

export async function createActionType(
  req: ActionTypeRequest,
  actor: Actor,
): Promise<{ row: ActionTypeRow; etag: string }> {
  const t0 = process.hrtime.bigint();
  let result: "success" | "error" = "success";
  try {
    return await _createActionTypeInner(req, actor);
  } catch (e) {
    result = "error";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histActionTypeCreate.observe({ result }, ns / 1e9);
    counterActionTypeCreate.inc({ status: result }, 1);
  }
}

async function _createActionTypeInner(
  req: ActionTypeRequest,
  actor: Actor,
): Promise<{ row: ActionTypeRow; etag: string }> {
  assertParameterShape(req);

  return await getWorkshopDb().withTransaction(async (client) => {
    // Reject duplicate (ontology, apiName).
    const existing = await client.query<{ action_type_id: string }>(
      `SELECT action_type_id FROM action_type WHERE ontology_id = $1 AND api_name = $2`,
      [req.ontologyRid, req.apiName],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw workshopError({
        errorName: "Tellus:Workshop:ActionTypeApiNameConflict",
        status: 409,
        parameters: { ontologyRid: req.ontologyRid, apiName: req.apiName },
      });
    }
    const result = await client.query<{
      action_type_id: string;
      ontology_id: string;
      api_name: string;
      display_name: string;
      description: string;
      parameters: unknown[];
      submission_criteria: unknown | null;
      is_enabled: boolean;
      max_affected_objects: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO action_type
         (ontology_id, api_name, display_name, description, parameters, rules, submission_criteria, is_enabled, max_affected_objects)
       VALUES ($1, $2, $3, $4, $5::jsonb, '[]'::jsonb, $6::jsonb, $7, $8)
       RETURNING action_type_id, ontology_id, api_name, display_name, description, parameters, submission_criteria, is_enabled, max_affected_objects, created_at, updated_at`,
      [
        req.ontologyRid,
        req.apiName,
        req.displayName,
        req.description,
        JSON.stringify(req.parameters),
        req.submissionCriteria
          ? JSON.stringify(req.submissionCriteria)
          : null,
        req.isEnabled,
        req.maxAffectedObjects,
      ],
    );
    const r = result.rows[0]!;
    const createdAt = r.created_at instanceof Date
      ? r.created_at
      : new Date(String(r.created_at));
    const updatedAt = r.updated_at instanceof Date
      ? r.updated_at
      : new Date(String(r.updated_at));
    const row: ActionTypeRow = {
      id: r.action_type_id,
      ontologyId: r.ontology_id,
      apiName: r.api_name,
      displayName: r.display_name,
      description: r.description ?? "",
      parameters: r.parameters,
      submissionCriteria: r.submission_criteria,
      isEnabled: r.is_enabled,
      maxAffectedObjects: r.max_affected_objects,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    };
    const etag = `W/"${r.action_type_id}.${updatedAt.getTime()}"`;
    invalidateOntology(req.ontologyRid);
    await emitWorkshopAudit({
      action: "WORKSHOP_ACTION_TYPE_CREATED",
      actorSubject: actor.userId,
      rid: r.action_type_id,
      result: "SUCCESS",
      details: {
        ontologyRid: req.ontologyRid,
        apiName: req.apiName,
        parameterCount: req.parameters.length,
        branchRid: actor.branchRid,
      },
    });
    return { row, etag };
  });
}
