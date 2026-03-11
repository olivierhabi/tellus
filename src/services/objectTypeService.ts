// ---------------------------------------------------------------------------
// Object Type Service Layer
//
// All business logic and database queries for Object Type CRUD operations.
// Object types have relationships with properties, datasources, and funnel
// state that must all be returned together on read operations.
// ---------------------------------------------------------------------------

import { query, getClient } from "../db";
import { validateObjectTypeName } from "../utils/apiNameValidator";
import { decodePageToken, encodePageToken } from "../utils/responseFormatter";
import propertyService from "./propertyService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateInput {
  apiName: string;
  displayName: string;
  description?: string | null;
  icon?: string;
  iconColor?: string;
  status?: string;
}

interface ListInput {
  pageSize?: number;
  pageToken?: string | null;
}

interface UpdateInput {
  displayName?: string;
  description?: string | null;
  icon?: string;
  iconColor?: string;
  status?: string;
}

// AppError imported from shared module
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/**
 * Create a new object type within an ontology.
 */
async function create(ontologyId: string, data: CreateInput) {
  const {
    apiName,
    displayName,
    description = null,
    icon = "cube",
    iconColor = "#1565C0",
    status = "active",
  } = data;

  // 1. Validate apiName
  const nameValidation = validateObjectTypeName(apiName);
  if (!nameValidation.valid) {
    throw appError("INVALID_API_NAME", nameValidation.error!);
  }

  // 2. Check ontology exists
  const ontologyCheck = await query(
    "SELECT ontology_id FROM ontology WHERE ontology_id = $1",
    [ontologyId]
  );
  if (ontologyCheck.rows.length === 0) {
    throw appError("ONTOLOGY_NOT_FOUND", `Ontology '${ontologyId}' not found.`);
  }

  // 3. Insert object type
  let row;
  try {
    const result = await query(
      `INSERT INTO object_type
         (ontology_id, api_name, display_name, description, icon, icon_color, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [ontologyId, apiName, displayName, description, icon, iconColor, status]
    );
    row = result.rows[0];
  } catch (err: any) {
    if (err.code === "23505") {
      throw appError(
        "OBJECT_TYPE_ALREADY_EXISTS",
        `Object type '${apiName}' already exists in this ontology.`
      );
    }
    throw err;
  }

  // 4. Create funnel_state record
  await query(
    "INSERT INTO funnel_state (object_type_id, status) VALUES ($1, 'not_indexed')",
    [row.object_type_id]
  );

  return row;
}

/**
 * Get an object type by API name, including properties, datasource, and
 * funnel state.
 */
async function getByApiName(ontologyId: string, apiName: string) {
  // 1. Object type
  const otResult = await query(
    "SELECT * FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${apiName}' not found in ontology '${ontologyId}'.`
    );
  }
  const objectType = otResult.rows[0];

  // 2. Properties
  const propsResult = await query(
    "SELECT * FROM property WHERE object_type_id = $1 ORDER BY ordinal, api_name",
    [objectType.object_type_id]
  );

  // 3. Backing datasource
  const dsResult = await query(
    "SELECT * FROM backing_datasource WHERE object_type_id = $1",
    [objectType.object_type_id]
  );

  // 4. Funnel state
  const fsResult = await query(
    "SELECT * FROM funnel_state WHERE object_type_id = $1",
    [objectType.object_type_id]
  );

  return {
    objectType,
    properties: propsResult.rows,
    datasource: dsResult.rows[0] || null,
    funnelState: fsResult.rows[0] || null,
  };
}

/**
 * List object types in an ontology with summary data.
 */
async function listByOntology(ontologyId: string, input: ListInput = {}) {
  const pageSize = Math.min(Math.max(input.pageSize || 100, 1), 1000);
  const offset = decodePageToken(input.pageToken);

  // Total count
  const countResult = await query(
    "SELECT COUNT(*)::int AS count FROM object_type WHERE ontology_id = $1",
    [ontologyId]
  );
  const totalCount: number = countResult.rows[0].count;

  // Page query with summary data
  const result = await query(
    `SELECT ot.*,
            COUNT(p.property_id)::int AS property_count,
            ds.dataset_name AS datasource_name,
            fs.status AS index_status,
            fs.objects_indexed
     FROM object_type ot
     LEFT JOIN property p ON ot.object_type_id = p.object_type_id
     LEFT JOIN backing_datasource ds ON ot.object_type_id = ds.object_type_id
     LEFT JOIN funnel_state fs ON ot.object_type_id = fs.object_type_id
     WHERE ot.ontology_id = $1
     GROUP BY ot.object_type_id, ds.dataset_name, fs.status, fs.objects_indexed
     ORDER BY ot.created_at DESC
     LIMIT $2 OFFSET $3`,
    [ontologyId, pageSize, offset]
  );

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
 * Update an object type. At least one field must be provided.
 */
async function update(ontologyId: string, apiName: string, data: UpdateInput) {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.displayName !== undefined) {
    setClauses.push(`display_name = $${paramIndex++}`);
    values.push(data.displayName);
  }
  if (data.description !== undefined) {
    setClauses.push(`description = $${paramIndex++}`);
    values.push(data.description);
  }
  if (data.icon !== undefined) {
    setClauses.push(`icon = $${paramIndex++}`);
    values.push(data.icon);
  }
  if (data.iconColor !== undefined) {
    setClauses.push(`icon_color = $${paramIndex++}`);
    values.push(data.iconColor);
  }
  if (data.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    values.push(data.status);
  }

  if (setClauses.length === 0) {
    throw appError(
      "INVALID_PARAMETER",
      "At least one field must be provided for update."
    );
  }

  // Always update updated_at
  setClauses.push("updated_at = NOW()");

  // WHERE clause params
  values.push(ontologyId);
  values.push(apiName);

  const sql = `UPDATE object_type
               SET ${setClauses.join(", ")}
               WHERE ontology_id = $${paramIndex++} AND api_name = $${paramIndex}
               RETURNING *`;

  try {
    const result = await query(sql, values);
    if (result.rows.length === 0) {
      throw appError(
        "OBJECT_TYPE_NOT_FOUND",
        `Object type '${apiName}' not found in ontology '${ontologyId}'.`
      );
    }

    const row = result.rows[0];

    // Warn if status changed to deprecated
    if (data.status === "deprecated") {
      console.warn(
        `Object type ${apiName} set to deprecated — dependent applications may break.`
      );
    }

    return row;
  } catch (err: any) {
    if (err.code === "23505") {
      throw appError(
        "OBJECT_TYPE_ALREADY_EXISTS",
        `Object type with that name already exists in this ontology.`
      );
    }
    throw err;
  }
}

/**
 * Delete an object type and all associated resources (properties,
 * backing_datasource, funnel_state via CASCADE).
 */
async function remove(ontologyId: string, apiName: string): Promise<void> {
  // 1. Look up the object type
  const otResult = await query(
    "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${apiName}' not found in ontology '${ontologyId}'.`
    );
  }
  const objectTypeId = otResult.rows[0].object_type_id;

  // 2. Guard: check for link_type references (future table)
  const tableCheck = await query(
    "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'link_type') AS exists"
  );
  if (tableCheck.rows[0].exists) {
    const linkRefs = await query(
      "SELECT link_type_id, api_name FROM link_type WHERE source_object_type = $1 OR target_object_type = $1",
      [objectTypeId]
    );
    if (linkRefs.rows.length > 0) {
      const names = linkRefs.rows.map((r: any) => r.api_name).join(", ");
      throw appError(
        "VALIDATION_FAILED",
        `Cannot delete object type: referenced by link types: [${names}]`
      );
    }
  }

  // 3. Delete (CASCADE handles properties, backing_datasource, funnel_state)
  await query("DELETE FROM object_type WHERE object_type_id = $1", [
    objectTypeId,
  ]);

  console.log(
    `Deleted object type ${apiName} (${objectTypeId}) with all cascaded resources`
  );
}

// ---------------------------------------------------------------------------
// Method 6: changeStatus
// ---------------------------------------------------------------------------

const VALID_STATUSES = ["active", "experimental", "deprecated"];

/**
 * Change an object type's status (active → experimental → deprecated, etc.).
 */
async function changeStatus(
  ontologyId: string,
  apiName: string,
  newStatus: string
) {
  // 1. Validate newStatus
  if (!VALID_STATUSES.includes(newStatus)) {
    throw appError(
      "VALIDATION_FAILED",
      "Invalid status. Must be one of: active, experimental, deprecated."
    );
  }

  // 2. Look up the object type
  const otResult = await query(
    "SELECT * FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${apiName}' not found in ontology '${ontologyId}'.`
    );
  }

  // 3. Warn on deprecation
  if (newStatus === "deprecated") {
    console.warn(
      `Object type '${apiName}' set to deprecated — dependent applications may break.`
    );
  }

  // 4. Update
  const updateResult = await query(
    `UPDATE object_type SET status = $1, updated_at = NOW()
     WHERE object_type_id = $2 RETURNING *`,
    [newStatus, otResult.rows[0].object_type_id]
  );

  return updateResult.rows[0];
}

// ---------------------------------------------------------------------------
// Method 7: clone
// ---------------------------------------------------------------------------

/**
 * Clone an object type's schema (properties, PK, title) into a new object
 * type. Does NOT copy backing datasource or funnel state. The clone starts
 * with status 'experimental'.
 *
 * Uses a database transaction for atomicity.
 */
async function clone(
  ontologyId: string,
  sourceApiName: string,
  newApiName: string,
  newDisplayName: string
) {
  // 1. Fetch source object type
  const srcOtResult = await query(
    "SELECT * FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, sourceApiName]
  );
  if (srcOtResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${sourceApiName}' not found in ontology '${ontologyId}'.`
    );
  }
  const srcOt = srcOtResult.rows[0];

  // 2. Fetch source properties
  const srcPropsResult = await query(
    "SELECT * FROM property WHERE object_type_id = $1 ORDER BY ordinal",
    [srcOt.object_type_id]
  );
  const srcProps = srcPropsResult.rows;

  // 3. Validate newApiName
  const nameValidation = validateObjectTypeName(newApiName);
  if (!nameValidation.valid) {
    throw appError("INVALID_API_NAME", nameValidation.error!);
  }

  // 4. Resolve source PK and title api_names
  let srcPkApiName: string | null = null;
  let srcTitleApiName: string | null = null;
  if (srcOt.primary_key_property_id) {
    const pkProp = srcProps.find(
      (p: any) => p.property_id === srcOt.primary_key_property_id
    );
    srcPkApiName = pkProp ? pkProp.api_name : null;
  }
  if (srcOt.title_property_id) {
    const titleProp = srcProps.find(
      (p: any) => p.property_id === srcOt.title_property_id
    );
    srcTitleApiName = titleProp ? titleProp.api_name : null;
  }

  // 5. Use a transaction for atomicity
  const client = await getClient();
  try {
    await client.query("BEGIN");

    // 5a. Insert new object type (status = experimental, no PK/title yet)
    let cloneOtRow: any;
    try {
      const insertResult = await client.query(
        `INSERT INTO object_type
           (ontology_id, api_name, display_name, description, icon, icon_color, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'experimental')
         RETURNING *`,
        [
          ontologyId,
          newApiName,
          newDisplayName,
          srcOt.description,
          srcOt.icon,
          srcOt.icon_color,
        ]
      );
      cloneOtRow = insertResult.rows[0];
    } catch (err: any) {
      if (err.code === "23505") {
        throw appError(
          "OBJECT_TYPE_ALREADY_EXISTS",
          `Object type '${newApiName}' already exists in this ontology.`
        );
      }
      throw err;
    }

    // 5b. Clone each property
    for (const srcProp of srcProps) {
      await client.query(
        `INSERT INTO property
           (object_type_id, api_name, display_name, base_type, description,
            struct_schema, is_required, is_array, ordinal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          cloneOtRow.object_type_id,
          srcProp.api_name,
          srcProp.display_name,
          srcProp.base_type,
          srcProp.description,
          srcProp.struct_schema
            ? JSON.stringify(srcProp.struct_schema)
            : null,
          srcProp.is_required,
          srcProp.is_array,
          srcProp.ordinal,
        ]
      );
    }

    // 5c. Set primary key on the clone
    if (srcPkApiName) {
      const clonePkResult = await client.query(
        "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
        [cloneOtRow.object_type_id, srcPkApiName]
      );
      if (clonePkResult.rows.length > 0) {
        await client.query(
          "UPDATE object_type SET primary_key_property_id = $1 WHERE object_type_id = $2",
          [clonePkResult.rows[0].property_id, cloneOtRow.object_type_id]
        );
      }
    }

    // 5d. Set title property on the clone
    if (srcTitleApiName) {
      const cloneTitleResult = await client.query(
        "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
        [cloneOtRow.object_type_id, srcTitleApiName]
      );
      if (cloneTitleResult.rows.length > 0) {
        await client.query(
          "UPDATE object_type SET title_property_id = $1 WHERE object_type_id = $2",
          [cloneTitleResult.rows[0].property_id, cloneOtRow.object_type_id]
        );
      }
    }

    // 5e. Create funnel_state for the clone
    await client.query(
      "INSERT INTO funnel_state (object_type_id, status) VALUES ($1, 'not_indexed')",
      [cloneOtRow.object_type_id]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // 6. Return the full clone (same shape as getByApiName)
  return getByApiName(ontologyId, newApiName);
}

// ---------------------------------------------------------------------------
// Method 8: exportDefinition
// ---------------------------------------------------------------------------

/**
 * Export an object type's schema definition as a JSON-serializable object.
 * Does NOT include datasource config or actual data — only the schema.
 */
async function exportDefinition(ontologyId: string, apiName: string) {
  const full = await getByApiName(ontologyId, apiName);
  const ot = full.objectType;
  const props = full.properties;

  // Resolve primary key and title property api_names
  let primaryKeyProperty: string | null = null;
  let titleProperty: string | null = null;

  if (ot.primary_key_property_id) {
    const pkProp = props.find(
      (p: any) => p.property_id === ot.primary_key_property_id
    );
    primaryKeyProperty = pkProp ? pkProp.api_name : null;
  }
  if (ot.title_property_id) {
    const titleProp = props.find(
      (p: any) => p.property_id === ot.title_property_id
    );
    titleProperty = titleProp ? titleProp.api_name : null;
  }

  return {
    exportVersion: "1.0",
    exportedAt: new Date().toISOString(),
    objectType: {
      apiName: ot.api_name,
      displayName: ot.display_name,
      description: ot.description ?? null,
      icon: ot.icon,
      iconColor: ot.icon_color,
      status: ot.status,
      primaryKeyProperty,
      titleProperty,
      properties: props.map((p: any) => ({
        apiName: p.api_name,
        displayName: p.display_name,
        baseType: p.base_type,
        description: p.description ?? null,
        structSchema: p.struct_schema ?? null,
        isRequired: p.is_required,
        isArray: p.is_array,
        ordinal: p.ordinal,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Method 9: importDefinition
// ---------------------------------------------------------------------------

/**
 * Import a single object type from a JSON definition (the inverse of
 * exportDefinition). Uses a database transaction for atomicity — if any
 * step fails, the entire import is rolled back.
 */
async function importDefinition(
  ontologyId: string,
  definition: any
) {
  // 1. Validate export version
  if (definition.exportVersion !== "1.0") {
    throw appError(
      "VALIDATION_FAILED",
      `Unsupported export version: ${definition.exportVersion}. Expected: 1.0.`
    );
  }

  // 2. Validate required fields
  const otDef = definition.objectType;
  if (!otDef) {
    throw appError(
      "VALIDATION_FAILED",
      "definition.objectType is required."
    );
  }
  if (!otDef.apiName || !otDef.displayName) {
    throw appError(
      "VALIDATION_FAILED",
      "objectType.apiName and objectType.displayName are required."
    );
  }
  if (!Array.isArray(otDef.properties)) {
    throw appError(
      "VALIDATION_FAILED",
      "objectType.properties must be an array."
    );
  }

  // 3. Validate apiName format
  const nameValidation = validateObjectTypeName(otDef.apiName);
  if (!nameValidation.valid) {
    throw appError("INVALID_API_NAME", nameValidation.error!);
  }

  // 4. Use a transaction for atomicity
  const client = await getClient();
  try {
    await client.query("BEGIN");

    // 4a. Check ontology exists
    const ontCheck = await client.query(
      "SELECT ontology_id FROM ontology WHERE ontology_id = $1",
      [ontologyId]
    );
    if (ontCheck.rows.length === 0) {
      throw appError("ONTOLOGY_NOT_FOUND", `Ontology '${ontologyId}' not found.`);
    }

    // 4b. Check for existing object type with same apiName
    const existingCheck = await client.query(
      "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
      [ontologyId, otDef.apiName]
    );
    if (existingCheck.rows.length > 0) {
      throw appError(
        "OBJECT_TYPE_ALREADY_EXISTS",
        `Object type '${otDef.apiName}' already exists in this ontology.`
      );
    }

    // 4c. Insert object type
    let otRow: any;
    try {
      const otResult = await client.query(
        `INSERT INTO object_type
           (ontology_id, api_name, display_name, description, icon, icon_color, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          ontologyId,
          otDef.apiName,
          otDef.displayName,
          otDef.description ?? null,
          otDef.icon ?? "cube",
          otDef.iconColor ?? "#1565C0",
          otDef.status ?? "active",
        ]
      );
      otRow = otResult.rows[0];
    } catch (err: any) {
      if (err.code === "23505") {
        throw appError(
          "OBJECT_TYPE_ALREADY_EXISTS",
          `Object type '${otDef.apiName}' already exists in this ontology.`
        );
      }
      throw err;
    }
    const objectTypeId = otRow.object_type_id;

    // 4d. Create funnel_state record
    await client.query(
      "INSERT INTO funnel_state (object_type_id, status) VALUES ($1, 'not_indexed')",
      [objectTypeId]
    );

    // 4e. Create each property
    for (const propDef of otDef.properties) {
      await propertyService.createWithClient(client, objectTypeId, {
        apiName: propDef.apiName,
        displayName: propDef.displayName,
        baseType: propDef.baseType,
        description: propDef.description ?? null,
        structSchema: propDef.structSchema ?? undefined,
        isRequired: propDef.isRequired ?? false,
        ordinal: propDef.ordinal ?? 0,
      });
    }

    // 4f. Set primary key if specified
    if (otDef.primaryKeyProperty) {
      const pkResult = await client.query(
        "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
        [objectTypeId, otDef.primaryKeyProperty]
      );
      if (pkResult.rows.length > 0) {
        await client.query(
          "UPDATE object_type SET primary_key_property_id = $1 WHERE object_type_id = $2",
          [pkResult.rows[0].property_id, objectTypeId]
        );
      }
    }

    // 4g. Set title property if specified
    if (otDef.titleProperty) {
      const titleResult = await client.query(
        "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
        [objectTypeId, otDef.titleProperty]
      );
      if (titleResult.rows.length > 0) {
        await client.query(
          "UPDATE object_type SET title_property_id = $1 WHERE object_type_id = $2",
          [titleResult.rows[0].property_id, objectTypeId]
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // 5. Return the full object type (same shape as getByApiName)
  return getByApiName(ontologyId, otDef.apiName);
}

// ---------------------------------------------------------------------------
// Method 10: getStatistics
// ---------------------------------------------------------------------------

/**
 * Return aggregated metrics about an object type: property counts by type,
 * datasource status, indexing metrics, and a computed health indicator.
 */
async function getStatistics(ontologyId: string, apiName: string) {
  // 1. Look up the object type
  const otResult = await query(
    "SELECT * FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${apiName}' not found in ontology '${ontologyId}'.`
    );
  }
  const objectType = otResult.rows[0];
  const objectTypeId = objectType.object_type_id;

  // 2. Property statistics
  const totalCountResult = await query(
    "SELECT COUNT(*)::int AS count FROM property WHERE object_type_id = $1",
    [objectTypeId]
  );
  const propertyCount: number = totalCountResult.rows[0].count;

  const byTypeResult = await query(
    "SELECT base_type, COUNT(*)::int AS count FROM property WHERE object_type_id = $1 GROUP BY base_type",
    [objectTypeId]
  );
  const propertiesByType: Record<string, number> = {};
  for (const row of byTypeResult.rows) {
    propertiesByType[row.base_type] = row.count;
  }

  const requiredResult = await query(
    "SELECT COUNT(*)::int AS count FROM property WHERE object_type_id = $1 AND is_required = true",
    [objectTypeId]
  );
  const requiredPropertyCount: number = requiredResult.rows[0].count;

  const arrayResult = await query(
    "SELECT COUNT(*)::int AS count FROM property WHERE object_type_id = $1 AND is_array = true",
    [objectTypeId]
  );
  const arrayPropertyCount: number = arrayResult.rows[0].count;

  // 3. Backing datasource (may be null)
  const dsResult = await query(
    "SELECT * FROM backing_datasource WHERE object_type_id = $1",
    [objectTypeId]
  );
  const dsRow = dsResult.rows[0] || null;

  // 4. Funnel state (may be null)
  const fsResult = await query(
    "SELECT * FROM funnel_state WHERE object_type_id = $1",
    [objectTypeId]
  );
  const fsRow = fsResult.rows[0] || null;

  // 5. Compute propertyCapacityUsed
  const maxProperties: number = objectType.max_properties || 2000;
  const propertyCapacityUsed =
    ((propertyCount / maxProperties) * 100).toFixed(1) + "%";

  // 6. Compute health
  let health: string;
  if (!fsRow || fsRow.status === "not_indexed") {
    health = "not_indexed";
  } else if (fsRow.status === "indexing") {
    health = "indexing";
  } else if (fsRow.status === "indexed") {
    if (fsRow.objects_failed === 0 && fsRow.edits_pending === 0) {
      health = "healthy";
    } else {
      health = "warning";
    }
  } else if (fsRow.status === "stale") {
    health = "warning";
  } else if (fsRow.status === "failed") {
    health = "error";
  } else {
    health = "not_indexed";
  }

  // 7. Build response
  return {
    statistics: {
      propertyCount,
      propertiesByType,
      requiredPropertyCount,
      arrayPropertyCount,
      propertyCapacityUsed,
      datasource: dsRow
        ? {
            status: "registered",
            filePath: dsRow.file_path,
            fileFormat: dsRow.file_format,
            rowCount: dsRow.row_count ?? null,
            lastScanned: dsRow.last_scanned_at ?? null,
          }
        : null,
      indexing: fsRow
        ? {
            status: fsRow.status,
            objectsIndexed: fsRow.objects_indexed,
            objectsFailed: fsRow.objects_failed,
            editsPending: fsRow.edits_pending,
            lastIndexedAt: fsRow.last_indexed_at ?? null,
            lastDurationMs: fsRow.last_index_duration_ms ?? null,
          }
        : null,
      health,
    },
  };
}

// ---------------------------------------------------------------------------
// Method 11: batchCreate
// ---------------------------------------------------------------------------

interface BatchCreateInput {
  apiName: string;
  displayName: string;
  description?: string | null;
  icon?: string;
  iconColor?: string;
  properties: Array<{
    apiName: string;
    displayName: string;
    baseType: string;
    description?: string | null;
    structSchema?: unknown;
    isRequired?: boolean;
    ordinal?: number;
  }>;
  primaryKeyProperty: string;
  titleProperty?: string | null;
}

/**
 * Atomically create an object type with all its properties, primary key,
 * and optional title property in a single transaction.
 */
async function batchCreate(ontologyId: string, data: BatchCreateInput) {
  const {
    apiName,
    displayName,
    description = null,
    icon = "cube",
    iconColor = "#1565C0",
    properties,
    primaryKeyProperty,
    titleProperty = null,
  } = data;

  // 1. Validate apiName
  const nameValidation = validateObjectTypeName(apiName);
  if (!nameValidation.valid) {
    throw appError("INVALID_API_NAME", nameValidation.error!);
  }

  // 2. Check ontology exists
  const ontologyCheck = await query(
    "SELECT ontology_id FROM ontology WHERE ontology_id = $1",
    [ontologyId]
  );
  if (ontologyCheck.rows.length === 0) {
    throw appError("ONTOLOGY_NOT_FOUND", `Ontology '${ontologyId}' not found.`);
  }

  // 3. Validate primaryKeyProperty references a property in the array
  const propertyApiNames = properties.map((p) => p.apiName);
  if (!propertyApiNames.includes(primaryKeyProperty)) {
    throw appError(
      "VALIDATION_FAILED",
      `primaryKeyProperty '${primaryKeyProperty}' does not match any property apiName.`
    );
  }

  // 4. Validate titleProperty references a property in the array (if provided)
  if (titleProperty && !propertyApiNames.includes(titleProperty)) {
    throw appError(
      "VALIDATION_FAILED",
      `titleProperty '${titleProperty}' does not match any property apiName.`
    );
  }

  // 5. Use a transaction for atomicity
  const client = await getClient();
  try {
    await client.query("BEGIN");

    // 5a. Create object type
    let otRow: any;
    try {
      const otResult = await client.query(
        `INSERT INTO object_type
           (ontology_id, api_name, display_name, description, icon, icon_color, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')
         RETURNING *`,
        [ontologyId, apiName, displayName, description, icon, iconColor]
      );
      otRow = otResult.rows[0];
    } catch (err: any) {
      if (err.code === "23505") {
        throw appError(
          "OBJECT_TYPE_ALREADY_EXISTS",
          `Object type '${apiName}' already exists in this ontology.`
        );
      }
      throw err;
    }

    // 5b. Create funnel_state record
    await client.query(
      "INSERT INTO funnel_state (object_type_id, status) VALUES ($1, 'not_indexed')",
      [otRow.object_type_id]
    );

    // 5c. Create all properties
    for (const propDef of properties) {
      await propertyService.createWithClient(client, otRow.object_type_id, {
        apiName: propDef.apiName,
        displayName: propDef.displayName,
        baseType: propDef.baseType,
        description: propDef.description ?? null,
        structSchema: propDef.structSchema ?? null,
        isRequired: propDef.isRequired ?? false,
        ordinal: propDef.ordinal ?? 0,
      });
    }

    // 5d. Set primary key
    const pkResult = await client.query(
      "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
      [otRow.object_type_id, primaryKeyProperty]
    );
    if (pkResult.rows.length > 0) {
      await client.query(
        "UPDATE object_type SET primary_key_property_id = $1 WHERE object_type_id = $2",
        [pkResult.rows[0].property_id, otRow.object_type_id]
      );
    }

    // 5e. Set title property (if provided)
    if (titleProperty) {
      const titleResult = await client.query(
        "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
        [otRow.object_type_id, titleProperty]
      );
      if (titleResult.rows.length > 0) {
        await client.query(
          "UPDATE object_type SET title_property_id = $1 WHERE object_type_id = $2",
          [titleResult.rows[0].property_id, otRow.object_type_id]
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // 6. Return the full object type (same shape as getByApiName)
  return getByApiName(ontologyId, apiName);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const objectTypeService = {
  create,
  getByApiName,
  listByOntology,
  update,
  delete: remove,
  changeStatus,
  clone,
  exportDefinition,
  importDefinition,
  getStatistics,
  batchCreate,
};
export default objectTypeService;
