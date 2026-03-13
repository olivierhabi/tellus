// ---------------------------------------------------------------------------
// ModifyObject Rule Handler
//
// Complete implementation of the modifyObject rule type. Modifies properties
// on an existing object — performs a partial update where only the specified
// properties are changed; all other properties retain their current values.
//
// Key difference from createObject: the target object MUST already exist,
// and only specified properties are changed (not the full object). The
// handler fetches the current state to verify existence, then produces an
// edit record containing only the changed properties.
//
// The handler orchestrates:
//   1. Resolve the object reference to get the target PK
//   2. Verify the target object exists in OpenSearch
//   3. Load object type schema (with caching)
//   4. Resolve property values from parameters/static/computed sources
//   5. Reject primary key modifications (PK is immutable)
//   6. Validate property values via propertyValidator (operation='update')
//   7. Check for no-op (zero properties to change)
//   8. Produce the edit record
// ---------------------------------------------------------------------------

import objectTypeService from "../../services/objectTypeService";
import { fetchObject } from "../objectChecker";
import { validatePropertyValues } from "../propertyValidator";
import type { PropertyDefinition } from "../propertyValidator";
import type { ObjectTypeSchema, RuleContext } from "./createObjectRule";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A value source descriptor in a rule's property mapping. */
interface ValueSource {
  source: "parameter" | "static" | "currentTimestamp" | "currentUser";
  param?: string;
  value?: unknown;
}

/** A modifyObject rule definition. */
export interface ModifyObjectRuleDef {
  type: "modifyObject";
  objectType: string;
  objectReference: ValueSource;
  properties: Record<string, ValueSource>;
}

/** System properties updated on modify. */
interface ModifySystemProperties {
  __lastModified: string;
  __editedBy: string;
}

/** The edit record produced by this handler. */
export interface ModifyObjectEdit {
  objectType: string;
  primaryKey: string;
  operation: "update";
  propertyValues: Record<string, unknown>;
  systemProperties: ModifySystemProperties;
  linkEdits: unknown[];
}

/** Result of processModifyObjectRule. */
export interface ModifyObjectResult {
  edit: ModifyObjectEdit | null;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Processes a modifyObject rule and produces an edit record.
 *
 * @param rule               - The modifyObject rule definition
 * @param resolvedParameters - Validated parameters from the parameter validator
 * @param context            - { executedBy, ontologyId, schemaCache? }
 * @returns { edit, errors }
 */
export async function processModifyObjectRule(
  rule: ModifyObjectRuleDef,
  resolvedParameters: Record<string, unknown>,
  context: RuleContext
): Promise<ModifyObjectResult> {
  const errors: string[] = [];

  // Ensure schemaCache exists
  if (!context.schemaCache) {
    context.schemaCache = new Map();
  }

  // -----------------------------------------------------------------
  // Step 1: Resolve the object reference
  // -----------------------------------------------------------------
  const pkValue = resolveValue(rule.objectReference, resolvedParameters, context);

  if (pkValue === undefined || pkValue === null) {
    return {
      edit: null,
      errors: [
        "modifyObject rule has no object reference — cannot determine which object to modify",
      ],
    };
  }

  const primaryKey = String(pkValue);

  // -----------------------------------------------------------------
  // Step 2: Verify the target object exists
  // -----------------------------------------------------------------
  let existingObject: Record<string, unknown> | null;
  try {
    existingObject = await fetchObject(rule.objectType, primaryKey);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      edit: null,
      errors: [
        `Failed to verify existence of object '${primaryKey}' of type '${rule.objectType}': ${msg}`,
      ],
    };
  }

  if (!existingObject) {
    return {
      edit: null,
      errors: [
        `modifyObject rule targets object '${primaryKey}' of type '${rule.objectType}' which does not exist ` +
          `in the Ontology. Use a createObject rule to create new objects.`,
      ],
    };
  }

  // -----------------------------------------------------------------
  // Step 3: Load object type schema (with caching)
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
        `modifyObject rule references non-existent object type '${rule.objectType}'`,
      ],
    };
  }

  const objectTypeDef = schema.objectType;
  const properties = schema.properties;

  // Build property definition lookup
  const propDefMap = new Map<string, Record<string, unknown>>();
  for (const prop of properties) {
    propDefMap.set(prop.api_name as string, prop);
  }

  // Find the primary key property api_name
  const pkPropertyId = objectTypeDef.primary_key_property_id as string | null;
  let pkApiName: string | null = null;
  if (pkPropertyId) {
    const pkProp = properties.find((p) => p.property_id === pkPropertyId);
    if (pkProp) {
      pkApiName = pkProp.api_name as string;
    }
  }

  // -----------------------------------------------------------------
  // Step 4: Resolve property values
  // -----------------------------------------------------------------
  const resolvedValues: Record<string, unknown> = {};
  const now = new Date().toISOString();

  // Check that rule doesn't reference unknown properties
  for (const propName of Object.keys(rule.properties)) {
    if (!propDefMap.has(propName)) {
      errors.push(
        `modifyObject rule references property '${propName}' which does not exist on object type '${rule.objectType}'`
      );
    }
  }

  if (errors.length > 0) {
    return { edit: null, errors };
  }

  for (const [propName, source] of Object.entries(rule.properties)) {
    const propDef = propDefMap.get(propName);
    if (!propDef) continue;

    const propBaseType = propDef.base_type as string;

    switch (source.source) {
      case "parameter": {
        const paramValue = resolvedParameters[source.param!];
        // undefined means "parameter not provided" → don't change this property
        // null means "explicitly set to null" → include in edit (clears the value)
        if (paramValue === undefined) {
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
          `modifyObject rule property '${propName}' has unknown source '${(source as any).source}'`
        );
    }
  }

  if (errors.length > 0) {
    return { edit: null, errors };
  }

  // -----------------------------------------------------------------
  // Array coercion: wrap scalar values for array-typed properties
  // -----------------------------------------------------------------
  for (const [propName, value] of Object.entries(resolvedValues)) {
    if (value === null || value === undefined) continue;
    const propDef = propDefMap.get(propName);
    if (!propDef) continue;
    const baseType = propDef.base_type as string;
    if (baseType.endsWith("_array") && !Array.isArray(value)) {
      resolvedValues[propName] = [value];
    }
  }

  // -----------------------------------------------------------------
  // Step 5: Reject primary key modifications
  // -----------------------------------------------------------------
  if (pkApiName && pkApiName in resolvedValues) {
    return {
      edit: null,
      errors: [
        `Cannot modify the primary key property '${pkApiName}' of an existing object. ` +
          `Primary keys are immutable. To change an object's primary key, delete it and create a new object.`,
      ],
    };
  }

  // -----------------------------------------------------------------
  // Step 6: Validate property values (operation='update')
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
    "update",
    propDefs
  );

  if (!validation.valid) {
    return { edit: null, errors: validation.errors };
  }

  // -----------------------------------------------------------------
  // Step 7: Check for no-op
  // -----------------------------------------------------------------
  if (Object.keys(validation.coercedValues).length === 0) {
    return {
      edit: null,
      errors: [
        `modifyObject rule for object '${primaryKey}' of type '${rule.objectType}' has no properties to update. ` +
          `At least one property must be changed.`,
      ],
    };
  }

  // -----------------------------------------------------------------
  // Step 8: Produce the edit record
  // -----------------------------------------------------------------
  const systemProperties: ModifySystemProperties = {
    __lastModified: now,
    __editedBy: context.executedBy,
  };

  return {
    edit: {
      objectType: rule.objectType,
      primaryKey,
      operation: "update",
      propertyValues: validation.coercedValues,
      systemProperties,
      linkEdits: [],
    },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a single value source to a concrete value.
 */
function resolveValue(
  source: ValueSource,
  resolvedParameters: Record<string, unknown>,
  context: RuleContext
): unknown {
  switch (source.source) {
    case "parameter":
      return resolvedParameters[source.param!];
    case "static":
      return source.value;
    case "currentTimestamp":
      return new Date().toISOString();
    case "currentUser":
      return context.executedBy;
    default:
      return undefined;
  }
}

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

export default { processModifyObjectRule };
