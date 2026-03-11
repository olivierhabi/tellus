// ---------------------------------------------------------------------------
// Link Type Model
//
// CRUD operations for link types. A link type defines a directed
// relationship between two object types (source → target), resolved
// via foreign-key properties on either side.
//
// Cardinalities:
//   ONE_TO_ONE   — source PK ↔ target PK (1:1 via a shared FK)
//   ONE_TO_MANY  — source PK → target FK column (1 source has N targets)
//   MANY_TO_ONE  — source FK → target PK (N sources point to 1 target)
//   MANY_TO_MANY — join through intermediate data (both FKs stored)
// ---------------------------------------------------------------------------

import { query, getClient } from "../db";
import { appError } from "../utils/appError";
import { validateLinkTypeName } from "../utils/apiNameValidator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Cardinality = "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_ONE" | "MANY_TO_MANY";

export interface LinkTypeRow {
  link_type_id: string;
  ontology_id: string;
  api_name: string;
  display_name: string;
  description: string | null;
  cardinality: Cardinality;
  source_object_type: string;
  target_object_type: string;
  source_property_id: string | null;
  target_property_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateLinkTypeInput {
  apiName: string;
  displayName: string;
  description?: string | null;
  cardinality: Cardinality;
  sourceObjectTypeApiName: string;
  targetObjectTypeApiName: string;
  sourcePropertyApiName?: string | null;
  targetPropertyApiName?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveObjectTypeId(ontologyId: string, apiName: string): Promise<string> {
  const result = await query(
    "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  if (result.rows.length === 0) {
    throw appError("OBJECT_TYPE_NOT_FOUND", `Object type '${apiName}' not found.`);
  }
  return result.rows[0].object_type_id;
}

async function resolvePropertyId(
  objectTypeId: string,
  propertyApiName: string
): Promise<string> {
  const result = await query(
    "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
    [objectTypeId, propertyApiName]
  );
  if (result.rows.length === 0) {
    throw appError("PROPERTY_NOT_FOUND", `Property '${propertyApiName}' not found.`);
  }
  return result.rows[0].property_id;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function create(
  ontologyId: string,
  input: CreateLinkTypeInput
): Promise<LinkTypeRow> {
  const nameValidation = validateLinkTypeName(input.apiName);
  if (!nameValidation.valid) {
    throw appError("INVALID_API_NAME", nameValidation.error!);
  }

  const sourceOtId = await resolveObjectTypeId(ontologyId, input.sourceObjectTypeApiName);
  const targetOtId = await resolveObjectTypeId(ontologyId, input.targetObjectTypeApiName);

  let sourcePropId: string | null = null;
  let targetPropId: string | null = null;

  if (input.sourcePropertyApiName) {
    sourcePropId = await resolvePropertyId(sourceOtId, input.sourcePropertyApiName);
  }
  if (input.targetPropertyApiName) {
    targetPropId = await resolvePropertyId(targetOtId, input.targetPropertyApiName);
  }

  try {
    const result = await query(
      `INSERT INTO link_type
         (ontology_id, api_name, display_name, description, cardinality,
          source_object_type, target_object_type, source_property_id, target_property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        ontologyId,
        input.apiName,
        input.displayName,
        input.description ?? null,
        input.cardinality,
        sourceOtId,
        targetOtId,
        sourcePropId,
        targetPropId,
      ]
    );
    return result.rows[0] as LinkTypeRow;
  } catch (err: any) {
    if (err.code === "23505") {
      throw appError("ALREADY_EXISTS", `Link type '${input.apiName}' already exists in this ontology.`);
    }
    throw err;
  }
}

async function getByApiName(
  ontologyId: string,
  apiName: string
): Promise<LinkTypeRow | null> {
  const result = await query(
    "SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  return result.rows.length > 0 ? (result.rows[0] as LinkTypeRow) : null;
}

async function listByOntology(ontologyId: string): Promise<LinkTypeRow[]> {
  const result = await query(
    "SELECT * FROM link_type WHERE ontology_id = $1 ORDER BY created_at",
    [ontologyId]
  );
  return result.rows as LinkTypeRow[];
}

async function remove(ontologyId: string, apiName: string): Promise<void> {
  const result = await query(
    "DELETE FROM link_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  if (result.rowCount === 0) {
    throw appError("LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
  }
}

export default { create, getByApiName, listByOntology, remove };
export { create, getByApiName, listByOntology, remove };
