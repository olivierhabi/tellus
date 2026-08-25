// ---------------------------------------------------------------------------
// Interface Link Constraint Model
//
// CRUD + lookup helpers for the `interface_link_constraint` table created
// by migration 128. An interface link constraint publishes a polymorphic,
// interface-typed relationship contract published by an interface. The
// Phase 2 runtime resolver (`actions/rules/interfaceLinkRules.ts`) finds
// the concrete `link_type`(s) implemented for the resolved source/target
// object types, applies authorization, and — for *creation* — fails when
// resolution is ambiguous (more than one concrete link type satisfies the
// constraint). For *deletion*, every matching concrete implementation is
// deleted (deterministic, auditable).
// ---------------------------------------------------------------------------

import { query } from "../db";
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InterfaceLinkConstraintCardinality =
  | "ONE_TO_ONE"
  | "ONE_TO_MANY"
  | "MANY_TO_ONE"
  | "MANY_TO_MANY";

export type InterfaceLinkConstraintStatus = "draft" | "active" | "deprecated";

export interface InterfaceLinkConstraintRow {
  interface_link_constraint_id: string;
  ontology_id: string;
  api_name: string;
  display_name: string;
  description: string | null;
  interface_id: string;
  target_interface_id: string | null;
  target_object_type_id: string | null;
  cardinality: InterfaceLinkConstraintCardinality;
  source_role: string | null;
  target_role: string | null;
  status: InterfaceLinkConstraintStatus | null;
  created_at: string;
  updated_at: string;
}

export interface CreateInterfaceLinkConstraintInput {
  apiName: string;
  displayName: string;
  description?: string | null;
  /** Owning interface (api_name in this ontology). */
  interfaceApiName: string;
  /** Target interface (api_name) OR target object type (api_name). Exactly one must be set. */
  targetInterfaceApiName?: string | null;
  targetObjectTypeApiName?: string | null;
  cardinality: InterfaceLinkConstraintCardinality;
  sourceRole?: string | null;
  targetRole?: string | null;
  status?: InterfaceLinkConstraintStatus;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createInterfaceLinkConstraint(
  ontologyId: string,
  input: CreateInterfaceLinkConstraintInput,
): Promise<InterfaceLinkConstraintRow> {
  // XOR check: exactly one of target_interface / target_object_type
  if (!!input.targetInterfaceApiName === !!input.targetObjectTypeApiName) {
    throw appError(
      "VALIDATION_FAILED",
      "interfaceLinkConstraint requires EXACTLY ONE of targetInterfaceApiName or targetObjectTypeApiName.",
    );
  }

  // Resolve the owning interface_id by api_name
  const interfaceResult = await query(
    "SELECT interface_id FROM interface WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, input.interfaceApiName],
  );
  if (interfaceResult.rows.length === 0) {
    throw appError("INTERFACE_NOT_FOUND", `Interface '${input.interfaceApiName}' not found.`);
  }
  const interfaceId = interfaceResult.rows[0].interface_id;

  // Resolve the target_interface_id
  let targetInterfaceId: string | null = null;
  let targetObjectTypeId: string | null = null;
  if (input.targetInterfaceApiName) {
    const r = await query(
      "SELECT interface_id FROM interface WHERE ontology_id = $1 AND api_name = $2",
      [ontologyId, input.targetInterfaceApiName],
    );
    if (r.rows.length === 0) {
      throw appError("INTERFACE_NOT_FOUND", `Target interface '${input.targetInterfaceApiName}' not found.`);
    }
    targetInterfaceId = r.rows[0].interface_id;
  } else if (input.targetObjectTypeApiName) {
    const r = await query(
      "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
      [ontologyId, input.targetObjectTypeApiName],
    );
    if (r.rows.length === 0) {
      throw appError("OBJECT_TYPE_MISMATCH", `Target object type '${input.targetObjectTypeApiName}' not found.`);
    }
    targetObjectTypeId = r.rows[0].object_type_id;
  }

  try {
    const result = await query(
      `INSERT INTO interface_link_constraint
         (ontology_id, api_name, display_name, description,
          interface_id, target_interface_id, target_object_type_id,
          cardinality, source_role, target_role, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        ontologyId,
        input.apiName,
        input.displayName,
        input.description ?? null,
        interfaceId,
        targetInterfaceId,
        targetObjectTypeId,
        input.cardinality,
        input.sourceRole ?? null,
        input.targetRole ?? null,
        input.status ?? "draft",
      ],
    );
    return result.rows[0] as InterfaceLinkConstraintRow;
  } catch (err: any) {
    if (err.code === "23505") {
      throw appError(
        "INTERFACE_LINK_CONSTRAINT_ALREADY_EXISTS",
        `Interface link constraint '${input.apiName}' already exists in this ontology.`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getInterfaceLinkConstraintByApiName(
  ontologyId: string,
  apiName: string,
): Promise<InterfaceLinkConstraintRow | null> {
  const result = await query(
    "SELECT * FROM interface_link_constraint WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName],
  );
  return result.rows.length > 0 ? (result.rows[0] as InterfaceLinkConstraintRow) : null;
}

export async function listInterfaceLinkConstraints(
  ontologyId: string,
): Promise<InterfaceLinkConstraintRow[]> {
  const result = await query(
    "SELECT * FROM interface_link_constraint WHERE ontology_id = $1 ORDER BY api_name",
    [ontologyId],
  );
  return result.rows as InterfaceLinkConstraintRow[];
}

// ---------------------------------------------------------------------------
// Update + Delete (minimal — Phase 2 reserves runtime surface)
// ---------------------------------------------------------------------------

export async function updateInterfaceLinkConstraintStatus(
  ontologyId: string,
  apiName: string,
  status: InterfaceLinkConstraintStatus,
): Promise<InterfaceLinkConstraintRow | null> {
  const result = await query(
    `UPDATE interface_link_constraint
        SET status = $3, updated_at = now()
      WHERE ontology_id = $1 AND api_name = $2
      RETURNING *`,
    [ontologyId, apiName, status],
  );
  return result.rows.length > 0 ? (result.rows[0] as InterfaceLinkConstraintRow) : null;
}

export async function deleteInterfaceLinkConstraint(
  ontologyId: string,
  apiName: string,
): Promise<boolean> {
  const result = await query(
    "DELETE FROM interface_link_constraint WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName],
  );
  return (result.rowCount ?? 0) > 0;
}
