// ---------------------------------------------------------------------------
// Link Type Model
//
// CRUD operations for link types. A link type defines a directed
// relationship between two object types (source -> target), resolved
// via foreign-key properties on either side, or via a join table CSV
// for MANY_TO_MANY links.
//
// Cardinalities:
//   ONE_TO_ONE   — source PK <-> target PK (1:1 via a shared FK)
//   ONE_TO_MANY  — source PK -> target FK column (1 source has N targets)
//   MANY_TO_ONE  — source FK -> target PK (N sources point to 1 target)
//   MANY_TO_MANY — join through CSV file or FK properties
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
  join_table_file_path: string | null;
  join_table_source_column: string | null;
  join_table_target_column: string | null;
  is_bidirectional: boolean;
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
  joinTableFilePath?: string | null;
  joinTableSourceColumn?: string | null;
  joinTableTargetColumn?: string | null;
  isBidirectional?: boolean;
}

export interface UpdateLinkTypeInput {
  displayName?: string;
  description?: string | null;
  cardinality?: Cardinality;
  sourcePropertyApiName?: string | null;
  targetPropertyApiName?: string | null;
  joinTableFilePath?: string | null;
  joinTableSourceColumn?: string | null;
  joinTableTargetColumn?: string | null;
  isBidirectional?: boolean;
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

export async function resolveObjectTypeApiName(objectTypeId: string): Promise<string> {
  const result = await query(
    "SELECT api_name FROM object_type WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (result.rows.length === 0) {
    throw appError("OBJECT_TYPE_NOT_FOUND", `Object type with ID '${objectTypeId}' not found.`);
  }
  return result.rows[0].api_name;
}

export async function resolvePropertyApiName(propertyId: string): Promise<string> {
  const result = await query(
    "SELECT api_name FROM property WHERE property_id = $1",
    [propertyId]
  );
  if (result.rows.length === 0) {
    throw appError("PROPERTY_NOT_FOUND", `Property with ID '${propertyId}' not found.`);
  }
  return result.rows[0].api_name;
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
          source_object_type, target_object_type, source_property_id, target_property_id,
          join_table_file_path, join_table_source_column, join_table_target_column,
          is_bidirectional)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        input.joinTableFilePath ?? null,
        input.joinTableSourceColumn ?? null,
        input.joinTableTargetColumn ?? null,
        input.isBidirectional ?? false,
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

async function update(
  ontologyId: string,
  apiName: string,
  input: UpdateLinkTypeInput
): Promise<LinkTypeRow> {
  const existing = await getByApiName(ontologyId, apiName);
  if (!existing) {
    throw appError("LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
  }

  const warnings: string[] = [];

  // Detect breaking changes
  if (input.cardinality && input.cardinality !== existing.cardinality) {
    warnings.push(`Cardinality changed from ${existing.cardinality} to ${input.cardinality}.`);
  }

  // Resolve property IDs if provided
  let sourcePropId = existing.source_property_id;
  let targetPropId = existing.target_property_id;

  if (input.sourcePropertyApiName !== undefined) {
    if (input.sourcePropertyApiName === null) {
      sourcePropId = null;
    } else {
      sourcePropId = await resolvePropertyId(existing.source_object_type, input.sourcePropertyApiName);
    }
  }

  if (input.targetPropertyApiName !== undefined) {
    if (input.targetPropertyApiName === null) {
      targetPropId = null;
    } else {
      targetPropId = await resolvePropertyId(existing.target_object_type, input.targetPropertyApiName);
    }
  }

  const result = await query(
    `UPDATE link_type SET
       display_name = $1,
       description = $2,
       cardinality = $3,
       source_property_id = $4,
       target_property_id = $5,
       join_table_file_path = $6,
       join_table_source_column = $7,
       join_table_target_column = $8,
       is_bidirectional = $9,
       updated_at = now()
     WHERE ontology_id = $10 AND api_name = $11
     RETURNING *`,
    [
      input.displayName ?? existing.display_name,
      input.description !== undefined ? input.description : existing.description,
      input.cardinality ?? existing.cardinality,
      sourcePropId,
      targetPropId,
      input.joinTableFilePath !== undefined ? input.joinTableFilePath : existing.join_table_file_path,
      input.joinTableSourceColumn !== undefined ? input.joinTableSourceColumn : existing.join_table_source_column,
      input.joinTableTargetColumn !== undefined ? input.joinTableTargetColumn : existing.join_table_target_column,
      input.isBidirectional !== undefined ? input.isBidirectional : existing.is_bidirectional,
      ontologyId,
      apiName,
    ]
  );

  const row = result.rows[0] as LinkTypeRow;
  // Attach warnings as a non-enumerable property for the route to pick up
  (row as any)._warnings = warnings.length > 0 ? warnings : undefined;
  return row;
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

async function listByOntology(
  ontologyId: string,
  filters?: { sourceObjectType?: string; targetObjectType?: string; cardinality?: string }
): Promise<LinkTypeRow[]> {
  let sql = "SELECT * FROM link_type WHERE ontology_id = $1";
  const params: any[] = [ontologyId];

  if (filters?.sourceObjectType) {
    params.push(filters.sourceObjectType);
    sql += ` AND source_object_type = $${params.length}`;
  }
  if (filters?.targetObjectType) {
    params.push(filters.targetObjectType);
    sql += ` AND target_object_type = $${params.length}`;
  }
  if (filters?.cardinality) {
    params.push(filters.cardinality);
    sql += ` AND cardinality = $${params.length}`;
  }

  sql += " ORDER BY created_at";
  const result = await query(sql, params);
  return result.rows as LinkTypeRow[];
}

async function listByObjectType(
  ontologyId: string,
  objectTypeId: string
): Promise<Array<LinkTypeRow & { direction: "forward" | "reverse" }>> {
  const result = await query(
    `SELECT * FROM link_type WHERE ontology_id = $1
     AND (source_object_type = $2 OR target_object_type = $2)
     ORDER BY created_at`,
    [ontologyId, objectTypeId]
  );

  return (result.rows as LinkTypeRow[]).map((lt) => {
    const isSource = lt.source_object_type === objectTypeId;
    const isTarget = lt.target_object_type === objectTypeId;

    // If it's the source, it's forward. If it's the target (and not also source), it's reverse.
    // For self-referential links (source === target), include both directions.
    if (isSource && isTarget) {
      // Self-referential — mark as forward (caller can request reverse explicitly)
      return { ...lt, direction: "forward" as const };
    }
    if (isSource) {
      return { ...lt, direction: "forward" as const };
    }
    // isTarget only — only include if bidirectional
    if (lt.is_bidirectional) {
      return { ...lt, direction: "reverse" as const };
    }
    return { ...lt, direction: "reverse" as const };
  });
}

async function remove(ontologyId: string, apiName: string): Promise<LinkTypeRow | null> {
  const existing = await getByApiName(ontologyId, apiName);
  if (!existing) {
    throw appError("LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
  }

  await query(
    "DELETE FROM link_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );

  return existing;
}

async function countByOntology(ontologyId: string): Promise<number> {
  const result = await query(
    "SELECT COUNT(*)::int as count FROM link_type WHERE ontology_id = $1",
    [ontologyId]
  );
  return result.rows[0].count;
}

async function bulkInsert(ontologyId: string, linkTypes: CreateLinkTypeInput[]): Promise<{ created: LinkTypeRow[]; skipped: string[]; failed: Array<{ apiName: string; error: string }> }> {
  const created: LinkTypeRow[] = [];
  const skipped: string[] = [];
  const failed: Array<{ apiName: string; error: string }> = [];

  for (const input of linkTypes) {
    try {
      const existing = await getByApiName(ontologyId, input.apiName);
      if (existing) {
        skipped.push(input.apiName);
        continue;
      }
      const row = await create(ontologyId, input);
      created.push(row);
    } catch (err: any) {
      if (err.code === "ALREADY_EXISTS") {
        skipped.push(input.apiName);
      } else {
        failed.push({ apiName: input.apiName, error: err.message });
      }
    }
  }

  return { created, skipped, failed };
}

export default { create, update, getByApiName, listByOntology, listByObjectType, remove, countByOntology, bulkInsert };
export { create, update, getByApiName, listByOntology, listByObjectType, remove, countByOntology, bulkInsert, resolveObjectTypeId, resolvePropertyId };

// ---------------------------------------------------------------------------
// Inline self-tests
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) { passed++; } else { failed++; console.error(`  FAIL: ${label}`); }
  }

  console.log("Running linkType model self-tests...\n");

  // Test type definitions
  const testRow: LinkTypeRow = {
    link_type_id: "test-uuid",
    ontology_id: "ont-uuid",
    api_name: "testLink",
    display_name: "Test Link",
    description: null,
    cardinality: "ONE_TO_MANY",
    source_object_type: "src-uuid",
    target_object_type: "tgt-uuid",
    source_property_id: null,
    target_property_id: "prop-uuid",
    join_table_file_path: null,
    join_table_source_column: null,
    join_table_target_column: null,
    is_bidirectional: false,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };

  assert(testRow.api_name === "testLink", "LinkTypeRow has api_name");
  assert(testRow.cardinality === "ONE_TO_MANY", "LinkTypeRow has cardinality");
  assert(testRow.is_bidirectional === false, "LinkTypeRow has is_bidirectional");
  assert(testRow.join_table_file_path === null, "LinkTypeRow has join_table_file_path");

  // Test CreateLinkTypeInput
  const testInput: CreateLinkTypeInput = {
    apiName: "testLink",
    displayName: "Test Link",
    cardinality: "MANY_TO_MANY",
    sourceObjectTypeApiName: "Employee",
    targetObjectTypeApiName: "Department",
    joinTableFilePath: "/data/emp_dept.csv",
    joinTableSourceColumn: "employee_id",
    joinTableTargetColumn: "department_id",
    isBidirectional: true,
  };

  assert(testInput.apiName === "testLink", "CreateLinkTypeInput has apiName");
  assert(testInput.isBidirectional === true, "CreateLinkTypeInput has isBidirectional");
  assert(testInput.joinTableFilePath === "/data/emp_dept.csv", "CreateLinkTypeInput has joinTableFilePath");

  // Test UpdateLinkTypeInput
  const testUpdate: UpdateLinkTypeInput = {
    displayName: "Updated Link",
    cardinality: "ONE_TO_ONE",
    isBidirectional: false,
  };

  assert(testUpdate.displayName === "Updated Link", "UpdateLinkTypeInput has displayName");
  assert(testUpdate.cardinality === "ONE_TO_ONE", "UpdateLinkTypeInput has cardinality");

  // Test Cardinality type
  const cardinalities: Cardinality[] = ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"];
  assert(cardinalities.length === 4, "4 cardinality types");

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll linkType model tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
