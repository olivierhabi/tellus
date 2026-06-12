// ---------------------------------------------------------------------------
// Property Service Layer
//
// All business logic and database queries for Property CRUD operations.
// Validates base types against the type system, enforces the 2000-property
// limit, and handles primary key and title property assignment.
// ---------------------------------------------------------------------------

import { query, getClient } from "../db";
import { PoolClient } from "pg";
import { validatePropertyName } from "../utils/apiNameValidator";
import { VALID_BASE_TYPES, isArrayType } from "../utils/typeSystem";
import { validateStructSchema } from "../utils/structValidator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateInput {
  apiName: string;
  displayName: string;
  baseType: string;
  description?: string | null;
  structSchema?: unknown;
  isRequired?: boolean;
  ordinal?: number;
  /** Ordered conditional-formatting rules (FE ConditionalFormattingRule[]). */
  conditionalFormatting?: unknown;
}

interface UpdateInput {
  displayName?: string;
  description?: string | null;
  isRequired?: boolean;
  ordinal?: number;
  /** Replace the property's conditional-formatting rules (null clears them). */
  conditionalFormatting?: unknown;
  // Not updatable — checked and rejected:
  apiName?: string;
  baseType?: string;
}

// AppError imported from shared module
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Method 1: create
// ---------------------------------------------------------------------------

async function create(objectTypeId: string, data: CreateInput) {
  const {
    apiName,
    displayName,
    baseType,
    description = null,
    structSchema = null,
    isRequired = false,
    ordinal = 0,
    conditionalFormatting = null,
  } = data;

  // 1. Validate apiName
  const nameValidation = validatePropertyName(apiName);
  if (!nameValidation.valid) {
    throw appError("INVALID_API_NAME", nameValidation.error!);
  }

  // 2. Validate baseType
  if (!VALID_BASE_TYPES.includes(baseType)) {
    throw appError(
      "INVALID_BASE_TYPE",
      `Invalid base type '${baseType}'. Valid types: ${VALID_BASE_TYPES.join(", ")}.`
    );
  }

  // 3. struct validation — delegated to structValidator (Task 22)
  if (baseType === "struct") {
    if (structSchema !== null && structSchema !== undefined) {
      const structResult = validateStructSchema(structSchema);
      if (!structResult.valid) {
        throw appError(
          "VALIDATION_FAILED",
          structResult.errors!.join(" ")
        );
      }
    }
  }

  // 4. structSchema only valid for struct type
  if (baseType !== "struct" && structSchema !== null && structSchema !== undefined) {
    throw appError(
      "VALIDATION_FAILED",
      "structSchema can only be set when baseType is 'struct'."
    );
  }

  // 5. Check property count against max_properties limit
  const countResult = await query(
    "SELECT COUNT(*)::int AS count FROM property WHERE object_type_id = $1",
    [objectTypeId]
  );
  const currentCount: number = countResult.rows[0].count;

  const otResult = await query(
    "SELECT max_properties FROM object_type WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${objectTypeId}' not found.`
    );
  }
  const maxProperties: number = otResult.rows[0].max_properties;

  if (currentCount >= maxProperties) {
    throw appError(
      "VALIDATION_FAILED",
      `Maximum of ${maxProperties} properties per object type reached (current: ${currentCount}).`
    );
  }

  // 6. Auto-set is_array
  const isArray = isArrayType(baseType);

  // Insert
  try {
    const result = await query(
      `INSERT INTO property
         (object_type_id, api_name, display_name, base_type, description,
          struct_schema, is_required, is_array, ordinal, conditional_formatting)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        objectTypeId,
        apiName,
        displayName,
        baseType,
        description,
        structSchema ? JSON.stringify(structSchema) : null,
        isRequired,
        isArray,
        ordinal,
        conditionalFormatting ? JSON.stringify(conditionalFormatting) : null,
      ]
    );
    return result.rows[0];
  } catch (err: any) {
    if (err.code === "23505") {
      throw appError(
        "PROPERTY_ALREADY_EXISTS",
        `Property '${apiName}' already exists on this object type.`
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Method 2: getByApiName
// ---------------------------------------------------------------------------

async function getByApiName(objectTypeId: string, propertyApiName: string) {
  const result = await query(
    "SELECT * FROM property WHERE object_type_id = $1 AND api_name = $2",
    [objectTypeId, propertyApiName]
  );
  if (result.rows.length === 0) {
    throw appError(
      "PROPERTY_NOT_FOUND",
      `Property '${propertyApiName}' not found on this object type.`
    );
  }
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Method 3: listByObjectType
// ---------------------------------------------------------------------------

async function listByObjectType(objectTypeId: string) {
  const result = await query(
    "SELECT * FROM property WHERE object_type_id = $1 ORDER BY ordinal ASC, api_name ASC",
    [objectTypeId]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Method 4: update
// ---------------------------------------------------------------------------

async function update(
  objectTypeId: string,
  propertyApiName: string,
  data: UpdateInput
) {
  // Reject immutable fields
  if (data.apiName !== undefined) {
    throw appError(
      "VALIDATION_FAILED",
      "Cannot change apiName or baseType after creation. These are breaking changes that require creating a new property."
    );
  }
  if (data.baseType !== undefined) {
    throw appError(
      "VALIDATION_FAILED",
      "Cannot change apiName or baseType after creation. These are breaking changes that require creating a new property."
    );
  }

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
  if (data.isRequired !== undefined) {
    setClauses.push(`is_required = $${paramIndex++}`);
    values.push(data.isRequired);
  }
  if (data.ordinal !== undefined) {
    setClauses.push(`ordinal = $${paramIndex++}`);
    values.push(data.ordinal);
  }
  if (data.conditionalFormatting !== undefined) {
    setClauses.push(`conditional_formatting = $${paramIndex++}`);
    values.push(
      data.conditionalFormatting
        ? JSON.stringify(data.conditionalFormatting)
        : null
    );
  }

  if (setClauses.length === 0) {
    throw appError(
      "INVALID_PARAMETER",
      "At least one updatable field (displayName, description, isRequired, ordinal, conditionalFormatting) must be provided."
    );
  }

  // WHERE clause params
  values.push(objectTypeId);
  values.push(propertyApiName);

  const sql = `UPDATE property
               SET ${setClauses.join(", ")}
               WHERE object_type_id = $${paramIndex++} AND api_name = $${paramIndex}
               RETURNING *`;

  const result = await query(sql, values);
  if (result.rows.length === 0) {
    throw appError(
      "PROPERTY_NOT_FOUND",
      `Property '${propertyApiName}' not found on this object type.`
    );
  }

  // Also update the parent object_type's updated_at
  await query(
    "UPDATE object_type SET updated_at = NOW() WHERE object_type_id = $1",
    [objectTypeId]
  );

  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Method 5: delete
// ---------------------------------------------------------------------------

async function remove(
  objectTypeId: string,
  propertyApiName: string
): Promise<void> {
  // 1. Look up the property
  const propResult = await query(
    "SELECT * FROM property WHERE object_type_id = $1 AND api_name = $2",
    [objectTypeId, propertyApiName]
  );
  if (propResult.rows.length === 0) {
    throw appError(
      "PROPERTY_NOT_FOUND",
      `Property '${propertyApiName}' not found on this object type.`
    );
  }
  const property = propResult.rows[0];

  // 2. Check if this is the primary key
  const otResult = await query(
    "SELECT primary_key_property_id, title_property_id FROM object_type WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (otResult.rows.length > 0) {
    const ot = otResult.rows[0];

    if (ot.primary_key_property_id === property.property_id) {
      throw appError(
        "VALIDATION_FAILED",
        `Cannot delete the primary key property '${propertyApiName}'. Change the primary key first.`
      );
    }

    // 3. Warn if this is the title property (FK ON DELETE SET NULL handles it)
    if (ot.title_property_id === property.property_id) {
      console.warn(
        `Deleting title property '${propertyApiName}' — object type will have no title property.`
      );
    }
  }

  // 4. Guard check for link_type references (future table)
  const tableCheck = await query(
    "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'link_type') AS exists"
  );
  if (tableCheck.rows[0].exists) {
    const linkRefs = await query(
      `SELECT link_type_id, api_name FROM link_type
       WHERE source_property_id = $1 OR target_property_id = $1`,
      [property.property_id]
    );
    if (linkRefs.rows.length > 0) {
      const names = linkRefs.rows.map((r: any) => r.api_name).join(", ");
      throw appError(
        "VALIDATION_FAILED",
        `Cannot delete property: referenced by link types: [${names}]`
      );
    }
  }

  // 5. Delete
  await query("DELETE FROM property WHERE property_id = $1", [
    property.property_id,
  ]);
}

// ---------------------------------------------------------------------------
// Method 6: setPrimaryKey
// ---------------------------------------------------------------------------

async function setPrimaryKey(objectTypeId: string, propertyApiName: string) {
  // Look up the property
  const propResult = await query(
    "SELECT * FROM property WHERE object_type_id = $1 AND api_name = $2",
    [objectTypeId, propertyApiName]
  );
  if (propResult.rows.length === 0) {
    throw appError(
      "PROPERTY_NOT_FOUND",
      `Property '${propertyApiName}' not found.`
    );
  }

  const result = await query(
    `UPDATE object_type
     SET primary_key_property_id = $1, updated_at = NOW()
     WHERE object_type_id = $2
     RETURNING *`,
    [propResult.rows[0].property_id, objectTypeId]
  );

  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Method 7: setTitleProperty
// ---------------------------------------------------------------------------

async function setTitleProperty(objectTypeId: string, propertyApiName: string) {
  // Look up the property
  const propResult = await query(
    "SELECT * FROM property WHERE object_type_id = $1 AND api_name = $2",
    [objectTypeId, propertyApiName]
  );
  if (propResult.rows.length === 0) {
    throw appError(
      "PROPERTY_NOT_FOUND",
      `Property '${propertyApiName}' not found.`
    );
  }

  const result = await query(
    `UPDATE object_type
     SET title_property_id = $1, updated_at = NOW()
     WHERE object_type_id = $2
     RETURNING *`,
    [propResult.rows[0].property_id, objectTypeId]
  );

  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Method 8: createWithClient (transactional variant of create)
// ---------------------------------------------------------------------------

/**
 * Create a property using an existing PoolClient (for use within a
 * transaction). Performs the same validations as `create` but executes
 * queries on the provided client instead of the shared pool.
 */
async function createWithClient(
  client: PoolClient,
  objectTypeId: string,
  data: CreateInput
) {
  const {
    apiName,
    displayName,
    baseType,
    description = null,
    structSchema = null,
    isRequired = false,
    ordinal = 0,
    conditionalFormatting = null,
  } = data;

  // 1. Validate apiName
  const nameValidation = validatePropertyName(apiName);
  if (!nameValidation.valid) {
    throw appError("INVALID_API_NAME", nameValidation.error!);
  }

  // 2. Validate baseType
  if (!VALID_BASE_TYPES.includes(baseType)) {
    throw appError(
      "INVALID_BASE_TYPE",
      `Invalid base type '${baseType}'. Valid types: ${VALID_BASE_TYPES.join(", ")}.`
    );
  }

  // 3. struct validation
  if (baseType === "struct") {
    if (structSchema !== null && structSchema !== undefined) {
      const structResult = validateStructSchema(structSchema);
      if (!structResult.valid) {
        throw appError("VALIDATION_FAILED", structResult.errors!.join(" "));
      }
    }
  }

  // 4. structSchema only valid for struct type
  if (baseType !== "struct" && structSchema !== null && structSchema !== undefined) {
    throw appError(
      "VALIDATION_FAILED",
      "structSchema can only be set when baseType is 'struct'."
    );
  }

  // 5. Check property count against max_properties limit
  const countResult = await client.query(
    "SELECT COUNT(*)::int AS count FROM property WHERE object_type_id = $1",
    [objectTypeId]
  );
  const currentCount: number = countResult.rows[0].count;

  const otResult = await client.query(
    "SELECT max_properties FROM object_type WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${objectTypeId}' not found.`
    );
  }
  const maxProperties: number = otResult.rows[0].max_properties;

  if (currentCount >= maxProperties) {
    throw appError(
      "VALIDATION_FAILED",
      `Maximum of ${maxProperties} properties per object type reached (current: ${currentCount}).`
    );
  }

  // 6. Auto-set is_array
  const isArray = isArrayType(baseType);

  // Insert
  try {
    const result = await client.query(
      `INSERT INTO property
         (object_type_id, api_name, display_name, base_type, description,
          struct_schema, is_required, is_array, ordinal, conditional_formatting)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        objectTypeId,
        apiName,
        displayName,
        baseType,
        description,
        structSchema ? JSON.stringify(structSchema) : null,
        isRequired,
        isArray,
        ordinal,
        conditionalFormatting ? JSON.stringify(conditionalFormatting) : null,
      ]
    );
    return result.rows[0];
  } catch (err: any) {
    if (err.code === "23505") {
      throw appError(
        "PROPERTY_ALREADY_EXISTS",
        `Property '${apiName}' already exists on this object type.`
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Method 9: validatePropertyInput (pure validation, no DB)
// ---------------------------------------------------------------------------

/**
 * Validate a single property input without touching the database.
 * Returns an array of error messages (empty if valid).
 */
function validatePropertyInput(data: CreateInput): string[] {
  const errors: string[] = [];

  // apiName
  const nameValidation = validatePropertyName(data.apiName);
  if (!nameValidation.valid) {
    errors.push(`Property '${data.apiName}': ${nameValidation.error}`);
  }

  // baseType
  if (!VALID_BASE_TYPES.includes(data.baseType)) {
    errors.push(
      `Property '${data.apiName}': Invalid base type '${data.baseType}'.`
    );
  }

  // struct validation
  if (data.baseType === "struct" && data.structSchema) {
    const structResult = validateStructSchema(data.structSchema);
    if (!structResult.valid) {
      errors.push(
        `Property '${data.apiName}': ${structResult.errors!.join(" ")}`
      );
    }
  }

  // structSchema only valid for struct
  if (
    data.baseType !== "struct" &&
    data.structSchema !== null &&
    data.structSchema !== undefined
  ) {
    errors.push(
      `Property '${data.apiName}': structSchema can only be set when baseType is 'struct'.`
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Method 10: batchCreate
// ---------------------------------------------------------------------------

/**
 * Atomically create multiple properties on an existing object type.
 * Validates ALL properties before inserting ANY. If any validation fails,
 * no properties are created.
 */
async function batchCreate(
  objectTypeId: string,
  properties: CreateInput[]
) {
  // 1. Check object type exists and get max_properties
  const otResult = await query(
    "SELECT max_properties FROM object_type WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${objectTypeId}' not found.`
    );
  }
  const maxProperties: number = otResult.rows[0].max_properties;

  // 2. Get current property count
  const countResult = await query(
    "SELECT COUNT(*)::int AS count FROM property WHERE object_type_id = $1",
    [objectTypeId]
  );
  const currentCount: number = countResult.rows[0].count;

  // 3. Check capacity
  if (currentCount + properties.length > maxProperties) {
    throw appError(
      "VALIDATION_FAILED",
      `Adding ${properties.length} properties would exceed the limit of ${maxProperties} (current: ${currentCount}).`
    );
  }

  // 4. Validate ALL properties before inserting any
  const allErrors: string[] = [];
  for (const propDef of properties) {
    const errors = validatePropertyInput(propDef);
    allErrors.push(...errors);
  }

  // Check for duplicate apiNames within the batch
  const apiNameSet = new Set<string>();
  for (const propDef of properties) {
    if (apiNameSet.has(propDef.apiName)) {
      allErrors.push(
        `Duplicate property apiName '${propDef.apiName}' in batch.`
      );
    }
    apiNameSet.add(propDef.apiName);
  }

  if (allErrors.length > 0) {
    throw appError("VALIDATION_FAILED", allErrors.join(" "));
  }

  // 5. Use a transaction for atomicity
  const client = await getClient();
  const createdRows: any[] = [];

  try {
    await client.query("BEGIN");

    for (const propDef of properties) {
      const row = await createWithClient(client, objectTypeId, propDef);
      createdRows.push(row);
    }

    // Update parent object_type's updated_at
    await client.query(
      "UPDATE object_type SET updated_at = NOW() WHERE object_type_id = $1",
      [objectTypeId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return createdRows;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const propertyService = {
  create,
  createWithClient,
  getByApiName,
  listByObjectType,
  update,
  delete: remove,
  setPrimaryKey,
  setTitleProperty,
  batchCreate,
};
export default propertyService;
