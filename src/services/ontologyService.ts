// ---------------------------------------------------------------------------
// Ontology Service Layer
//
// All business logic and database queries for Ontology CRUD operations.
// Route handlers stay thin — they delegate to these methods and format the
// response.
// ---------------------------------------------------------------------------

import { query } from "../db";
import { decodePageToken, encodePageToken } from "../utils/responseFormatter";
import objectTypeService from "./objectTypeService";
import { ensureMainBranchId } from "./branchContext";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateInput {
  displayName: string;
  description?: string | null;
  createdBy?: string;
}

interface ListInput {
  pageSize?: number;
  pageToken?: string | null;
}

interface UpdateInput {
  displayName?: string;
  description?: string | null;
}

// AppError imported from shared module
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/**
 * Create a new ontology.
 */
async function create(input: CreateInput) {
  const {
    displayName,
    description = null,
    createdBy = "system",
  } = input;

  // Check uniqueness
  const existing = await query(
    "SELECT ontology_id FROM ontology WHERE display_name = $1",
    [displayName]
  );
  if (existing.rows.length > 0) {
    throw appError(
      "ONTOLOGY_ALREADY_EXISTS",
      `An ontology with display name '${displayName}' already exists.`
    );
  }

  // Insert
  const result = await query(
    `INSERT INTO ontology (display_name, description, created_by)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [displayName, description, createdBy]
  );

  // Every ontology must have a synthetic `main` branch so branch-scoped
  // writes (link_edit, ontology_edit — both NOT NULL on branch_id since
  // migration 040) can resolve a default. Migration 040 only backfills
  // ontologies that existed at migration time; freshly-created ones
  // need this eager insert to keep the invariant.
  await ensureMainBranchId(result.rows[0].ontology_id);

  return result.rows[0];
}

/**
 * Get an ontology by ID, including its object type count.
 */
async function getById(ontologyId: string) {
  const result = await query(
    "SELECT * FROM ontology WHERE ontology_id = $1",
    [ontologyId]
  );
  if (result.rows.length === 0) {
    throw appError(
      "ONTOLOGY_NOT_FOUND",
      `Ontology '${ontologyId}' not found.`
    );
  }

  const countResult = await query(
    "SELECT COUNT(*)::int AS count FROM object_type WHERE ontology_id = $1",
    [ontologyId]
  );

  const row = result.rows[0];
  row.object_type_count = countResult.rows[0].count;
  return row;
}

/**
 * List ontologies with pagination and object type counts.
 */
async function list(input: ListInput = {}) {
  const pageSize = Math.min(Math.max(input.pageSize || 100, 1), 1000);
  const offset = decodePageToken(input.pageToken);

  // Total count
  const countResult = await query("SELECT COUNT(*)::int AS count FROM ontology");
  const totalCount: number = countResult.rows[0].count;

  // Page query with object type counts
  const result = await query(
    `SELECT o.*, COALESCE(ot_count.count, 0)::int AS object_type_count
     FROM ontology o
     LEFT JOIN (
       SELECT ontology_id, COUNT(*) AS count
       FROM object_type
       GROUP BY ontology_id
     ) ot_count ON o.ontology_id = ot_count.ontology_id
     ORDER BY o.created_at DESC
     LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );

  // Compute next page token
  const nextPageToken =
    offset + pageSize < totalCount
      ? encodePageToken(offset + pageSize)
      : null;

  return {
    data: result.rows,
    totalCount,
    pageSize,
    nextPageToken,
  };
}

/**
 * Update an ontology. At least one field must be provided.
 */
async function update(ontologyId: string, input: UpdateInput) {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.displayName !== undefined) {
    setClauses.push(`display_name = $${paramIndex++}`);
    values.push(input.displayName);
  }
  if (input.description !== undefined) {
    setClauses.push(`description = $${paramIndex++}`);
    values.push(input.description);
  }

  if (setClauses.length === 0) {
    throw appError(
      "INVALID_PARAMETER",
      "At least one field (displayName or description) must be provided for update."
    );
  }

  // Always update updated_at
  setClauses.push(`updated_at = NOW()`);

  // Add ontologyId as the last parameter
  values.push(ontologyId);

  const sql = `UPDATE ontology SET ${setClauses.join(", ")} WHERE ontology_id = $${paramIndex} RETURNING *`;

  try {
    const result = await query(sql, values);
    if (result.rows.length === 0) {
      throw appError(
        "ONTOLOGY_NOT_FOUND",
        `Ontology '${ontologyId}' not found.`
      );
    }
    return result.rows[0];
  } catch (err: unknown) {
    // Translate PG unique violation on display_name
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      throw appError(
        "ONTOLOGY_ALREADY_EXISTS",
        `An ontology with display name '${input.displayName}' already exists.`
      );
    }
    throw err;
  }
}

/**
 * Delete an ontology and all cascaded resources.
 */
async function remove(ontologyId: string): Promise<void> {
  // Check existence
  const existing = await query(
    "SELECT ontology_id FROM ontology WHERE ontology_id = $1",
    [ontologyId]
  );
  if (existing.rows.length === 0) {
    throw appError(
      "ONTOLOGY_NOT_FOUND",
      `Ontology '${ontologyId}' not found.`
    );
  }

  // Delete (cascades through object_type -> property, backing_datasource, funnel_state)
  await query("DELETE FROM ontology WHERE ontology_id = $1", [ontologyId]);
  console.log(`Deleted ontology ${ontologyId} with all cascaded resources`);
}

// ---------------------------------------------------------------------------
// Method 6: exportOntology
// ---------------------------------------------------------------------------

/**
 * Export an entire ontology definition (all object types and properties)
 * as a JSON-serializable object for backup/restore/migration.
 */
async function exportOntology(ontologyId: string) {
  // 1. Fetch the ontology
  const ontResult = await query(
    "SELECT * FROM ontology WHERE ontology_id = $1",
    [ontologyId]
  );
  if (ontResult.rows.length === 0) {
    throw appError(
      "ONTOLOGY_NOT_FOUND",
      `Ontology '${ontologyId}' not found.`
    );
  }
  const ont = ontResult.rows[0];

  // 2. Fetch all object types in this ontology
  const otResult = await query(
    "SELECT * FROM object_type WHERE ontology_id = $1 ORDER BY created_at",
    [ontologyId]
  );

  // 3. For each object type, call exportDefinition and extract the objectType
  const objectTypes: any[] = [];
  for (const ot of otResult.rows) {
    const exported = await objectTypeService.exportDefinition(
      ontologyId,
      ot.api_name
    );
    // Strip per-type exportVersion and exportedAt — those are for single exports
    objectTypes.push(exported.objectType);
  }

  // 4. Build the full ontology export
  return {
    exportVersion: "1.0",
    exportedAt: new Date().toISOString(),
    exportedFrom: "ontology-engine-v0.1.0",
    ontology: {
      displayName: ont.display_name,
      description: ont.description ?? null,
      objectTypes,
      linkTypes: [],
      actionTypes: [],
      interfaces: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Method 7: importOntology
// ---------------------------------------------------------------------------

/**
 * Import an ontology from a previously exported JSON definition.
 * Creates the ontology and all object types atomically.
 * If displayName already exists, appends " (imported)", " (imported 2)", etc.
 */
async function importOntology(definition: any) {
  // 1. Validate exportVersion
  if (definition.exportVersion !== "1.0") {
    throw appError(
      "VALIDATION_FAILED",
      "Unsupported export version. Expected: 1.0."
    );
  }

  // 2. Validate ontology structure
  const ontDef = definition.ontology;
  if (!ontDef || !ontDef.displayName || !Array.isArray(ontDef.objectTypes)) {
    throw appError(
      "VALIDATION_FAILED",
      "ontology must have displayName and objectTypes (array)."
    );
  }

  // 3. Find a unique display name
  let displayName = ontDef.displayName;
  let suffix = 0;

  const nameExists = async (name: string): Promise<boolean> => {
    const r = await query(
      "SELECT ontology_id FROM ontology WHERE display_name = $1",
      [name]
    );
    return r.rows.length > 0;
  };

  if (await nameExists(displayName)) {
    suffix = 1;
    let candidate = `${ontDef.displayName} (imported)`;
    while (await nameExists(candidate)) {
      suffix++;
      candidate = `${ontDef.displayName} (imported ${suffix})`;
    }
    displayName = candidate;
  }

  // 4. Create the ontology
  const ontRow = await create({
    displayName,
    description: ontDef.description ?? null,
    createdBy: "import",
  });
  const newOntologyId = ontRow.ontology_id;

  // 5. Import each object type
  try {
    for (const otDef of ontDef.objectTypes) {
      await objectTypeService.importDefinition(newOntologyId, {
        exportVersion: "1.0",
        objectType: otDef,
      });
    }
  } catch (err) {
    // Rollback: delete the ontology (CASCADE deletes all object types/props)
    await query("DELETE FROM ontology WHERE ontology_id = $1", [newOntologyId]);
    throw err;
  }

  // 6. Count object types for the response
  const countResult = await query(
    "SELECT COUNT(*)::int AS count FROM object_type WHERE ontology_id = $1",
    [newOntologyId]
  );

  ontRow.object_type_count = countResult.rows[0].count;
  return ontRow;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const ontologyService = {
  create,
  getById,
  list,
  update,
  delete: remove,
  exportOntology,
  importOntology,
};
export default ontologyService;
