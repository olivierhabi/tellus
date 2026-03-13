// ---------------------------------------------------------------------------
// CreateObject Rule Handler
//
// Complete implementation of the createObject rule type. Creates a brand new
// object in the Ontology with the specified property values. This is the
// most common rule type — every "Create Employee", "File Tax Return",
// "Register Business" action uses it.
//
// The handler orchestrates:
//   1. Load object type schema (with caching)
//   2. Resolve property values from parameters/static/computed sources
//   3. Identify and validate the primary key
//   4. Check for duplicate primary key in OpenSearch
//   5. Validate all property types via propertyValidator
//   6. Add system properties
//   7. Produce the edit record
//
// If ANY step fails, the entire rule fails and no edit is produced.
// ---------------------------------------------------------------------------

import objectTypeService from "../../services/objectTypeService";
import { objectExists } from "../objectChecker";
import { validatePropertyValues } from "../propertyValidator";
import type { PropertyDefinition } from "../propertyValidator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A value source descriptor in a rule's property mapping. */
interface ValueSource {
  source: "parameter" | "static" | "currentTimestamp" | "currentUser";
  param?: string;
  value?: unknown;
}

/** A createObject rule definition. */
export interface CreateObjectRuleDef {
  type: "createObject";
  objectType: string;
  properties: Record<string, ValueSource>;
}

/** Execution context passed through the pipeline. */
export interface RuleContext {
  executedBy: string;
  ontologyId: string;
  schemaCache?: Map<string, ObjectTypeSchema>;
}

/** Cached schema for an object type. */
export interface ObjectTypeSchema {
  objectType: Record<string, unknown>;
  properties: Array<Record<string, unknown>>;
}

/** System properties added to every object. */
export interface SystemProperties {
  __pk: string;
  __objectType: string;
  __lastModified: string;
  __editedBy: string;
  __version: number;
}

/** The edit record produced by this handler. */
export interface CreateObjectEdit {
  objectType: string;
  primaryKey: string;
  operation: "create";
  propertyValues: Record<string, unknown>;
  systemProperties: SystemProperties;
  linkEdits: unknown[];
}

/** Result of processCreateObjectRule. */
export interface CreateObjectResult {
  edit: CreateObjectEdit | null;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Processes a createObject rule and produces an edit record.
 *
 * @param rule               - The createObject rule definition
 * @param resolvedParameters - Validated parameters from the parameter validator
 * @param context            - { executedBy, ontologyId, schemaCache? }
 * @returns { edit, errors }
 */
export async function processCreateObjectRule(
  rule: CreateObjectRuleDef,
  resolvedParameters: Record<string, unknown>,
  context: RuleContext
): Promise<CreateObjectResult> {
  const errors: string[] = [];

  // Ensure schemaCache exists
  if (!context.schemaCache) {
    context.schemaCache = new Map();
  }

  // -----------------------------------------------------------------
  // Step 1: Load the object type definition (with caching)
  // -----------------------------------------------------------------
  let schema: ObjectTypeSchema;
  try {
    schema = await loadObjectTypeSchema(
      context.ontologyId,
      rule.objectType,
      context.schemaCache
    );
  } catch {
    return {
      edit: null,
      errors: [
        `createObject rule references non-existent object type '${rule.objectType}'`,
      ],
    };
  }

  const objectType = schema.objectType;
  const properties = schema.properties;

  // Build property definition lookup
  const propDefMap = new Map<string, Record<string, unknown>>();
  for (const prop of properties) {
    propDefMap.set(prop.api_name as string, prop);
  }

  // Find the primary key property
  const pkPropertyId = objectType.primary_key_property_id as string | null;
  let pkApiName: string | null = null;

  if (pkPropertyId) {
    const pkProp = properties.find(
      (p) => p.property_id === pkPropertyId
    );
    if (pkProp) {
      pkApiName = pkProp.api_name as string;
    }
  }

  // -----------------------------------------------------------------
  // Step 2: Resolve each property value
  // -----------------------------------------------------------------
  const resolvedValues: Record<string, unknown> = {};
  const now = new Date().toISOString();

  // First: check that rule doesn't reference unknown properties
  for (const propName of Object.keys(rule.properties)) {
    if (!propDefMap.has(propName)) {
      errors.push(
        `createObject rule references property '${propName}' which does not exist on object type '${rule.objectType}'`
      );
    }
  }

  if (errors.length > 0) {
    return { edit: null, errors };
  }

  for (const [propName, source] of Object.entries(rule.properties)) {
    const propDef = propDefMap.get(propName);
    if (!propDef) continue; // already caught above

    const propBaseType = propDef.base_type as string;
    const propRequired = propDef.is_required as boolean;

    switch (source.source) {
      case "parameter": {
        const paramValue = resolvedParameters[source.param!];
        if (paramValue === undefined) {
          // Parameter not provided
          if (propRequired) {
            errors.push(
              `createObject rule maps required property '${propName}' to parameter '${source.param}' which was not provided`
            );
          }
          // Skip optional properties with undefined parameters
          continue;
        }
        resolvedValues[propName] = paramValue;
        break;
      }

      case "static": {
        resolvedValues[propName] = source.value;
        break;
      }

      case "currentTimestamp": {
        if (propBaseType === "date") {
          // Truncate to YYYY-MM-DD
          resolvedValues[propName] = now.substring(0, 10);
        } else {
          resolvedValues[propName] = now;
        }
        break;
      }

      case "currentUser": {
        resolvedValues[propName] = context.executedBy;
        break;
      }

      default:
        errors.push(
          `createObject rule property '${propName}' has unknown source '${(source as any).source}'`
        );
    }
  }

  if (errors.length > 0) {
    return { edit: null, errors };
  }

  // -----------------------------------------------------------------
  // Edge case 3: Array property coercion
  // If the property is an array type and the value is not an array,
  // wrap it in an array.
  // -----------------------------------------------------------------
  for (const [propName, value] of Object.entries(resolvedValues)) {
    if (value === null || value === undefined) continue;
    const propDef = propDefMap.get(propName);
    if (!propDef) continue;
    const baseType = propDef.base_type as string;
    if (
      baseType.endsWith("_array") &&
      !Array.isArray(value)
    ) {
      resolvedValues[propName] = [value];
    }
  }

  // -----------------------------------------------------------------
  // Edge case 1: Check required properties not in rule at all
  // -----------------------------------------------------------------
  for (const prop of properties) {
    const apiName = prop.api_name as string;
    const isRequired = prop.is_required as boolean;

    if (isRequired && !(apiName in rule.properties) && resolvedValues[apiName] === undefined) {
      errors.push(
        `createObject rule for '${rule.objectType}' does not set required property '${apiName}'. ` +
          `All required properties must be set when creating an object.`
      );
    }
  }

  if (errors.length > 0) {
    return { edit: null, errors };
  }

  // -----------------------------------------------------------------
  // Step 3: Identify and validate the primary key
  // -----------------------------------------------------------------
  if (!pkApiName) {
    errors.push(
      `Object type '${rule.objectType}' has no primary key property configured`
    );
    return { edit: null, errors };
  }

  const pkValue = resolvedValues[pkApiName];
  if (pkValue === undefined || pkValue === null) {
    errors.push(
      `createObject rule does not set the primary key property '${pkApiName}' for object type '${rule.objectType}'. ` +
        `The primary key must be set when creating an object.`
    );
    return { edit: null, errors };
  }

  // PK is always a string at the index level
  const primaryKey = String(pkValue);
  if (primaryKey === "") {
    errors.push(
      `Primary key value for object type '${rule.objectType}' cannot be empty`
    );
    return { edit: null, errors };
  }

  // -----------------------------------------------------------------
  // Step 4: Check for duplicate primary key
  // -----------------------------------------------------------------
  try {
    const exists = await objectExists(rule.objectType, primaryKey);
    if (exists) {
      return {
        edit: null,
        errors: [
          `Cannot create object of type '${rule.objectType}' with primary key '${primaryKey}' — ` +
            `an object with this primary key already exists. Use a modifyObject rule to update existing objects.`,
        ],
      };
    }
  } catch (err: unknown) {
    // objectChecker throws on connection errors — propagate as a rule error
    const msg = err instanceof Error ? err.message : String(err);
    return {
      edit: null,
      errors: [
        `Failed to check primary key uniqueness for '${primaryKey}': ${msg}`,
      ],
    };
  }

  // -----------------------------------------------------------------
  // Step 5: Validate all property values
  // -----------------------------------------------------------------
  const propDefs: PropertyDefinition[] = properties.map((p) => ({
    api_name: p.api_name as string,
    display_name: (p.display_name as string) || (p.api_name as string),
    base_type: p.base_type as string,
    is_required: p.is_required as boolean,
    is_array: p.is_array as boolean,
    struct_schema: (p.struct_schema as any) ?? null,
  }));

  const validation = validatePropertyValues(
    rule.objectType,
    resolvedValues,
    "create",
    propDefs
  );

  if (!validation.valid) {
    return { edit: null, errors: validation.errors };
  }

  // -----------------------------------------------------------------
  // Step 6: Add system properties
  // -----------------------------------------------------------------
  const systemProperties: SystemProperties = {
    __pk: primaryKey,
    __objectType: rule.objectType,
    __lastModified: now,
    __editedBy: context.executedBy,
    __version: 1,
  };

  // -----------------------------------------------------------------
  // Step 7: Produce the edit record
  // -----------------------------------------------------------------
  return {
    edit: {
      objectType: rule.objectType,
      primaryKey,
      operation: "create",
      propertyValues: validation.coercedValues,
      systemProperties,
      linkEdits: [],
    },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Schema loading with cache
// ---------------------------------------------------------------------------

/**
 * Load an object type schema from the database, using the cache if available.
 * Throws if the object type does not exist.
 */
async function loadObjectTypeSchema(
  ontologyId: string,
  objectTypeApiName: string,
  cache: Map<string, ObjectTypeSchema>
): Promise<ObjectTypeSchema> {
  const cacheKey = `${ontologyId}::${objectTypeApiName}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // This throws OBJECT_TYPE_NOT_FOUND if not found
  const result = await objectTypeService.getByApiName(
    ontologyId,
    objectTypeApiName
  );

  const schema: ObjectTypeSchema = {
    objectType: result.objectType,
    properties: result.properties,
  };

  cache.set(cacheKey, schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { processCreateObjectRule };
