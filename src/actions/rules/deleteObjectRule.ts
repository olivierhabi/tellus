// ---------------------------------------------------------------------------
// DeleteObject Rule Handler
//
// Removes an object from the Ontology. The object must exist — attempting
// to delete a non-existent object is an error. Deletion is "soft" in the
// edit store (the edit record stays forever for audit purposes) but "hard"
// in OpenSearch (the document is removed from the index).
//
// Dangling links: any links pointing to/from the deleted object become
// "dangling". In week 1, we do NOT automatically clean up dangling links —
// that's a complex cascade operation. We just warn if the object has links.
//
// The handler orchestrates:
//   1. Resolve the object reference to get the target PK
//   2. Verify the target object exists in OpenSearch
//   3. Check for linked objects (warning, not error)
//   4. Produce the edit record
// ---------------------------------------------------------------------------

import objectTypeService from "../../services/objectTypeService";
import { fetchObject } from "../objectChecker";
import { listByObjectType as listLinkTypesByObjectType, resolvePropertyApiName } from "../../models/linkType";
import type { LinkTypeRow } from "../../models/linkType";
import { client as opensearchClient } from "../../services/opensearch/client";
import { getIndexName } from "../../services/opensearch/indexMappingGenerator";
import { query } from "../../db";
import type { ObjectTypeSchema, RuleContext } from "./createObjectRule";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A value source descriptor. */
interface ValueSource {
  source: "parameter" | "static" | "currentTimestamp" | "currentUser";
  param?: string;
  value?: unknown;
}

/** A deleteObject rule definition. */
export interface DeleteObjectRuleDef {
  type: "deleteObject";
  objectType: string;
  objectReference: ValueSource;
}

/** The edit record produced by this handler. */
export interface DeleteObjectEdit {
  objectType: string;
  primaryKey: string;
  operation: "delete";
  propertyValues: null;
  systemProperties: null;
  linkEdits: unknown[];
}

/** Result of processDeleteObjectRule. */
export interface DeleteObjectResult {
  edit: DeleteObjectEdit | null;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Processes a deleteObject rule and produces an edit record.
 *
 * @param rule               - The deleteObject rule definition
 * @param resolvedParameters - Validated parameters from the parameter validator
 * @param context            - { executedBy, ontologyId, schemaCache? }
 * @returns { edit, errors, warnings }
 */
export async function processDeleteObjectRule(
  rule: DeleteObjectRuleDef,
  resolvedParameters: Record<string, unknown>,
  context: RuleContext
): Promise<DeleteObjectResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

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
        "deleteObject rule has no object reference — cannot determine which object to delete",
      ],
      warnings: [],
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
      warnings: [],
    };
  }

  if (!existingObject) {
    return {
      edit: null,
      errors: [
        `deleteObject rule targets object '${primaryKey}' of type '${rule.objectType}' which does not exist`,
      ],
      warnings: [],
    };
  }

  // -----------------------------------------------------------------
  // Step 3: Check for linked objects (warning, not error)
  // -----------------------------------------------------------------
  try {
    await checkDanglingLinks(
      rule.objectType,
      primaryKey,
      context.ontologyId,
      context.schemaCache,
      warnings
    );
  } catch {
    // Link checking is best-effort — don't fail the delete if it errors
    warnings.push(
      `Could not check for linked objects of '${primaryKey}' — dangling links may exist after deletion`
    );
  }

  // -----------------------------------------------------------------
  // Step 4: Produce the edit record
  // -----------------------------------------------------------------
  return {
    edit: {
      objectType: rule.objectType,
      primaryKey,
      operation: "delete",
      propertyValues: null,
      systemProperties: null,
      linkEdits: [],
    },
    errors: [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Dangling link checker
// ---------------------------------------------------------------------------

/**
 * Check for objects linked to the object being deleted, and add warnings
 * for any that would become dangling.
 */
async function checkDanglingLinks(
  objectTypeApiName: string,
  primaryKey: string,
  ontologyId: string,
  schemaCache: Map<string, ObjectTypeSchema>,
  warnings: string[]
): Promise<void> {
  // Load the object type schema to get the object_type_id
  let schema: ObjectTypeSchema;
  try {
    schema = await loadObjectTypeSchema(ontologyId, objectTypeApiName, schemaCache);
  } catch {
    return; // Can't check links without schema
  }

  const objectTypeId = schema.objectType.object_type_id as string;

  // Get all link types involving this object type
  let linkTypes: Array<LinkTypeRow & { direction: "forward" | "reverse" }>;
  try {
    linkTypes = await listLinkTypesByObjectType(ontologyId, objectTypeId);
  } catch {
    return; // link_type table may not exist
  }

  if (linkTypes.length === 0) return;

  for (const lt of linkTypes) {
    const isSource = lt.source_object_type === objectTypeId;
    const isTarget = lt.target_object_type === objectTypeId;

    if (lt.cardinality === "MANY_TO_MANY") {
      // Check the link_edit table for active links
      await checkManyToManyLinks(lt, primaryKey, isSource, warnings);
    } else {
      // FK-based link: check for objects referencing this one
      await checkFkLinks(lt, primaryKey, isSource, isTarget, warnings);
    }
  }
}

/**
 * Check for many-to-many links in the link_edit table.
 */
async function checkManyToManyLinks(
  linkType: LinkTypeRow,
  primaryKey: string,
  isSource: boolean,
  warnings: string[]
): Promise<void> {
  // Count net active links where this object is source or target
  const column = isSource ? "source_primary_key" : "target_primary_key";

  const result = await query(
    `SELECT COUNT(*)::int AS count FROM (
       SELECT source_primary_key, target_primary_key,
              SUM(CASE WHEN operation = 'add' THEN 1 ELSE -1 END) AS net
       FROM link_edit
       WHERE link_type_api_name = $1 AND ${column} = $2
       GROUP BY source_primary_key, target_primary_key
       HAVING SUM(CASE WHEN operation = 'add' THEN 1 ELSE -1 END) > 0
     ) active_links`,
    [linkType.api_name, primaryKey]
  );

  const count = result.rows[0]?.count ?? 0;
  if (count > 0) {
    warnings.push(
      `Deleting object '${primaryKey}' will create ${count} dangling link(s) of type '${linkType.api_name}'. ` +
        `Linked objects will retain their link references but the target object will no longer exist.`
    );
  }
}

/**
 * Check for FK-based links by searching OpenSearch for documents
 * referencing this object via a foreign key property.
 */
async function checkFkLinks(
  linkType: LinkTypeRow,
  primaryKey: string,
  isSource: boolean,
  isTarget: boolean,
  warnings: string[]
): Promise<void> {
  // For FK-based links, determine which side has the FK referencing our object
  // ONE_TO_MANY: source=1, target=N → FK on target side (target_property_id)
  //   If we're deleting the source (the "1" side), targets point to us
  // MANY_TO_ONE: source=N, target=1 → FK on source side (source_property_id)
  //   If we're deleting the target (the "1" side), sources point to us
  // ONE_TO_ONE: check both

  let fkPropertyId: string | null = null;
  let searchObjectTypeId: string | null = null;

  if (linkType.cardinality === "ONE_TO_MANY" && isSource) {
    // We're the "one" side being deleted; targets reference us via target_property_id
    fkPropertyId = linkType.target_property_id;
    searchObjectTypeId = linkType.target_object_type;
  } else if (linkType.cardinality === "MANY_TO_ONE" && isTarget) {
    // We're the "one" side being deleted; sources reference us via source_property_id
    fkPropertyId = linkType.source_property_id;
    searchObjectTypeId = linkType.source_object_type;
  } else if (linkType.cardinality === "ONE_TO_ONE") {
    // Check whichever side references us
    if (isSource && linkType.target_property_id) {
      fkPropertyId = linkType.target_property_id;
      searchObjectTypeId = linkType.target_object_type;
    } else if (isTarget && linkType.source_property_id) {
      fkPropertyId = linkType.source_property_id;
      searchObjectTypeId = linkType.source_object_type;
    }
  }

  if (!fkPropertyId || !searchObjectTypeId) return;

  // Resolve the FK property api_name
  let fkPropertyApiName: string;
  try {
    fkPropertyApiName = await resolvePropertyApiName(fkPropertyId);
  } catch {
    return; // Can't resolve property — skip
  }

  // Resolve the search object type api_name
  let searchObjectTypeApiName: string;
  try {
    const otResult = await query(
      "SELECT api_name FROM object_type WHERE object_type_id = $1",
      [searchObjectTypeId]
    );
    if (otResult.rows.length === 0) return;
    searchObjectTypeApiName = otResult.rows[0].api_name;
  } catch {
    return;
  }

  // Search OpenSearch for documents where the FK property equals our PK
  const indexName = getIndexName(searchObjectTypeApiName);
  try {
    const { body } = await opensearchClient.count({
      index: indexName,
      body: {
        query: {
          term: { [fkPropertyApiName]: primaryKey },
        },
      },
    });

    const count = (body as any).count ?? 0;
    if (count > 0) {
      warnings.push(
        `Deleting object '${primaryKey}' will create ${count} dangling link(s) of type '${linkType.api_name}'. ` +
          `Linked objects will retain their foreign key values but the target object will no longer exist.`
      );
    }
  } catch {
    // Index may not exist or search may fail — skip silently
  }
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

export default { processDeleteObjectRule };
