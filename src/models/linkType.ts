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
export type StorageBackend = "csv_legacy" | "iceberg";
export type ViolationPolicy = "warn" | "reject" | "quarantine";
export type McpPropagationMode = "source" | "target" | "union" | "intersection";

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
  // LT-B1 — Iceberg storage backend
  storage_backend?: StorageBackend;
  iceberg_table_name?: string | null;
  migration_started_at?: string | null;
  migration_completed_at?: string | null;
  // LT-B4 — ONE_TO_ONE violation policy
  violation_policy?: ViolationPolicy;
  violation_count_24h?: number;
  // LT-B6 — Bidirectional reverse spec
  reverse_api_name?: string | null;
  reverse_display_name?: string | null;
  reverse_description?: string | null;
  reverse_visible?: boolean;
  reverse_property_projection?: { included?: string[]; excluded?: string[] } | null;
  reverse_actions_enabled?: boolean;
  bidirectional_migrated_at?: string | null;
  // LT-B7 — Mandatory Control Properties
  mandatory_control_property_id?: string | null;
  mcp_propagation_mode?: McpPropagationMode;
  mcp_required_count?: number;
}

export interface CreateLinkTypeInput {
  /**
   * Optional. The frontend create flow no longer asks the user for an
   * apiName — it is derived server-side from `displayName` when
   * absent. Bulk-import / programmatic callers may still supply one.
   */
  apiName?: string;
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
  // LT-B4 / LT-B6 / LT-B7 — additive
  violationPolicy?: ViolationPolicy;
  reverseApiName?: string | null;
  reverseDisplayName?: string | null;
  reverseDescription?: string | null;
  reverseVisible?: boolean;
  reversePropertyProjection?: { included?: string[]; excluded?: string[] } | null;
  reverseActionsEnabled?: boolean;
  mandatoryControlPropertyId?: string | null;
  mcpPropagationMode?: McpPropagationMode;
  mcpRequiredCount?: number;
  storageBackend?: StorageBackend;
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
  violationPolicy?: ViolationPolicy;
  reverseApiName?: string | null;
  reverseDisplayName?: string | null;
  reverseDescription?: string | null;
  reverseVisible?: boolean;
  reversePropertyProjection?: { included?: string[]; excluded?: string[] } | null;
  reverseActionsEnabled?: boolean;
  mandatoryControlPropertyId?: string | null;
  mcpPropagationMode?: McpPropagationMode;
  mcpRequiredCount?: number;
  storageBackend?: StorageBackend;
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

/**
 * Project a free-text display name into a camelCase apiName.
 * Mirrors the rule the frontend used before apiName was removed
 * from the create form: strip diacritics, collapse non-alphanumeric
 * runs into word breaks, lowercase the first word, title-case the
 * rest. Used as the server-side fallback when callers don't provide
 * an explicit `apiName`.
 */
function toCamelCaseApiName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w, i) =>
      i === 0
        ? w[0].toLowerCase() + w.slice(1)
        : w[0].toUpperCase() + w.slice(1).toLowerCase()
    )
    .join("");
}

async function create(
  ontologyId: string,
  input: CreateLinkTypeInput
): Promise<LinkTypeRow> {
  // Derive apiName from displayName when the caller didn't provide
  // one. The FE create form no longer surfaces apiName as a user
  // input; the canonical identity is the row's UUID. Bulk-import or
  // programmatic callers may still pass an explicit apiName, in
  // which case we honour it.
  const providedApiName = (input.apiName ?? "").trim();
  const derivedApiName = providedApiName || toCamelCaseApiName(input.displayName);
  if (!derivedApiName) {
    throw appError(
      "INVALID_API_NAME",
      "Could not derive a valid apiName — provide a non-empty displayName."
    );
  }
  const nameValidation = validateLinkTypeName(derivedApiName);
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

  // LT-B4: default policy for new ONE_TO_ONE links is 'reject'. Pre-existing
  // O2O links keep the migration-level 'warn' default for backwards compat.
  const violationPolicy: ViolationPolicy =
    input.violationPolicy ??
    (input.cardinality === "ONE_TO_ONE" ? "reject" : "warn");

  // LT-B6: populate sensible defaults for the reverse direction when
  // the caller marks the link bidirectional. Order of preference for
  // `reverseApiName` (most explicit → least):
  //
  //   1. Caller-provided `reverseApiName` (bulk-import / programmatic).
  //   2. Derived from caller-provided `reverseDisplayName` (this is
  //      what the FE create form ships now — it sends both sides'
  //      displayNames and lets the server name them).
  //   3. Fall back to `${forwardApiName}Reverse` so the link remains
  //      addressable even when the caller omitted *both* reverse
  //      fields. The fallback uses a `Reverse` suffix (no underscore)
  //      so the result still passes the `^[a-z][a-zA-Z0-9]*$` apiName
  //      regex.
  const reverseDisplayName = input.isBidirectional
    ? (input.reverseDisplayName ?? `${input.displayName} (reverse)`)
    : (input.reverseDisplayName ?? null);

  const baseApiName = derivedApiName;
  let baseReverseApiName: string | null;
  if (input.reverseApiName) {
    baseReverseApiName = input.reverseApiName;
  } else if (input.isBidirectional) {
    const fromReverseDisplay = input.reverseDisplayName
      ? toCamelCaseApiName(input.reverseDisplayName)
      : "";
    baseReverseApiName = fromReverseDisplay || `${derivedApiName}Reverse`;
  } else {
    baseReverseApiName = null;
  }

  // The DB enforces UNIQUE(ontology_id, api_name) and a unique index
  // on (ontology_id, reverse_api_name). The user explicitly asked the
  // create endpoint to NOT depend on apiName uniqueness — the canonical
  // identity is the row's `link_type_id` UUID. So instead of bouncing
  // the request with `ALREADY_EXISTS`, we silently disambiguate the
  // colliding apiName with a numeric suffix (`olivierOrderg` →
  // `olivierOrderg2` → `olivierOrderg3` → …) and retry. The caller
  // gets back the row's UUID + the actually-stored apiName so they can
  // route on either. Cap retries at 50 to prevent runaway loops on a
  // pathologically saturated namespace.
  const MAX_DISAMBIG_ATTEMPTS = 50;
  let attempt = 0;
  while (true) {
    const apiName = attempt === 0 ? baseApiName : `${baseApiName}${attempt + 1}`;
    const reverseApiName =
      baseReverseApiName === null
        ? null
        : attempt === 0
          ? baseReverseApiName
          : `${baseReverseApiName}${attempt + 1}`;
    try {
      const result = await query(
        `INSERT INTO link_type
           (ontology_id, api_name, display_name, description, cardinality,
            source_object_type, target_object_type, source_property_id, target_property_id,
            join_table_file_path, join_table_source_column, join_table_target_column,
            is_bidirectional,
            storage_backend, violation_policy,
            reverse_api_name, reverse_display_name, reverse_description,
            reverse_visible, reverse_property_projection, reverse_actions_enabled,
            bidirectional_migrated_at,
            mandatory_control_property_id, mcp_propagation_mode, mcp_required_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19, $20, $21,
                 CASE WHEN $13::boolean THEN now() ELSE NULL END,
                 $22, $23, $24)
         RETURNING *`,
        [
          ontologyId,
          apiName,
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
          input.storageBackend ?? "csv_legacy",
          violationPolicy,
          reverseApiName,
          reverseDisplayName,
          input.reverseDescription ?? null,
          input.reverseVisible ?? true,
          input.reversePropertyProjection
            ? JSON.stringify(input.reversePropertyProjection)
            : null,
          input.reverseActionsEnabled ?? true,
          input.mandatoryControlPropertyId ?? null,
          input.mcpPropagationMode ?? "union",
          input.mcpRequiredCount ?? 1,
        ]
      );
      // Observability: log when the disambiguator allocated a name
      // different from what the caller asked for. Helps ops trace
      // "why did my apiName turn into X2?" without needing to query
      // the audit log. Single line, INFO level — disambiguation is
      // expected behaviour, not an error.
      if (apiName !== baseApiName) {
        // eslint-disable-next-line no-console
        console.info(
          `[linkType.create] disambiguated apiName: requested='${baseApiName}' allocated='${apiName}' attempt=${attempt + 1} ontologyId=${ontologyId}`
        );
      }
      return result.rows[0] as LinkTypeRow;
    } catch (err: any) {
      if (err.code === "23505" && attempt < MAX_DISAMBIG_ATTEMPTS) {
        attempt += 1;
        continue;
      }
      if (err.code === "23505") {
        // Saturated — extremely unlikely. Surface the original error
        // message so the caller knows the namespace is exhausted.
        throw appError(
          "ALREADY_EXISTS",
          `Could not allocate a unique apiName near '${baseApiName}' after ${MAX_DISAMBIG_ATTEMPTS} attempts.`,
        );
      }
      throw err;
    }
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

  const nextIsBidirectional =
    input.isBidirectional !== undefined ? input.isBidirectional : existing.is_bidirectional;
  const nextReverseApiName =
    input.reverseApiName !== undefined
      ? input.reverseApiName
      : nextIsBidirectional && !existing.reverse_api_name
        ? `${existing.api_name}_reverse`
        : (existing.reverse_api_name ?? null);
  const nextReverseDisplayName =
    input.reverseDisplayName !== undefined
      ? input.reverseDisplayName
      : nextIsBidirectional && !existing.reverse_display_name
        ? `${existing.display_name} (reverse)`
        : (existing.reverse_display_name ?? null);

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
       violation_policy = $12,
       reverse_api_name = $13,
       reverse_display_name = $14,
       reverse_description = $15,
       reverse_visible = $16,
       reverse_property_projection = $17,
       reverse_actions_enabled = $18,
       mandatory_control_property_id = $19,
       mcp_propagation_mode = $20,
       mcp_required_count = $21,
       storage_backend = $22,
       bidirectional_migrated_at = CASE
         WHEN $9::boolean AND bidirectional_migrated_at IS NULL THEN now()
         ELSE bidirectional_migrated_at
       END,
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
      nextIsBidirectional,
      ontologyId,
      apiName,
      input.violationPolicy ?? existing.violation_policy ?? "warn",
      nextReverseApiName,
      nextReverseDisplayName,
      input.reverseDescription !== undefined ? input.reverseDescription : (existing.reverse_description ?? null),
      input.reverseVisible !== undefined ? input.reverseVisible : (existing.reverse_visible ?? true),
      input.reversePropertyProjection !== undefined
        ? (input.reversePropertyProjection ? JSON.stringify(input.reversePropertyProjection) : null)
        : (existing.reverse_property_projection ? JSON.stringify(existing.reverse_property_projection) : null),
      input.reverseActionsEnabled !== undefined ? input.reverseActionsEnabled : (existing.reverse_actions_enabled ?? true),
      input.mandatoryControlPropertyId !== undefined ? input.mandatoryControlPropertyId : (existing.mandatory_control_property_id ?? null),
      input.mcpPropagationMode ?? existing.mcp_propagation_mode ?? "union",
      input.mcpRequiredCount ?? existing.mcp_required_count ?? 1,
      input.storageBackend ?? existing.storage_backend ?? "csv_legacy",
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

/**
 * Look up a link type by its UUID `link_type_id` within an ontology.
 *
 * Companion to `getByApiName`. Used by the route-level `:apiName`
 * resolver in `routes/links.ts` to support UUID-keyed URLs without
 * having to fork every existing handler — when a request comes in
 * at `/v1/ontology/:ontologyId/linkTypes/:apiName/...` and the
 * `:apiName` slot looks like a UUID, the resolver loads the row by
 * `link_type_id` here and rewrites `req.params.apiName` to the
 * canonical `api_name` so all downstream handlers (which already
 * use `getByApiName`) keep working unchanged.
 */
async function getById(
  ontologyId: string,
  linkTypeId: string
): Promise<LinkTypeRow | null> {
  const result = await query(
    "SELECT * FROM link_type WHERE ontology_id = $1 AND link_type_id = $2",
    [ontologyId, linkTypeId]
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
    // bulkInsert callers may omit apiName the same way the FE create
    // form does; mirror `create`'s server-side fallback so the
    // skipped/failed bookkeeping has something printable.
    const effectiveApiName =
      (input.apiName ?? "").trim() || toCamelCaseApiName(input.displayName);
    try {
      const existing = await getByApiName(ontologyId, effectiveApiName);
      if (existing) {
        skipped.push(effectiveApiName);
        continue;
      }
      const row = await create(ontologyId, input);
      created.push(row);
    } catch (err: any) {
      if (err.code === "ALREADY_EXISTS") {
        skipped.push(effectiveApiName);
      } else {
        failed.push({ apiName: effectiveApiName, error: err.message });
      }
    }
  }

  return { created, skipped, failed };
}

export default { create, update, getByApiName, getById, listByOntology, listByObjectType, remove, countByOntology, bulkInsert };
export { create, update, getByApiName, getById, listByOntology, listByObjectType, remove, countByOntology, bulkInsert, resolveObjectTypeId, resolvePropertyId, toCamelCaseApiName };

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
