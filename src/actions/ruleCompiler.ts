// ---------------------------------------------------------------------------
// Rule Compiler
//
// Stage 4 of Palantir's action execution pipeline. Takes an action type's
// rules array and a set of resolved parameters, and compiles them into a
// flat list of Ontology edits (creates, updates, deletes).
//
// Per Palantir documentation: "When multiple rules are defined, the actions
// backend compiles rules to generate a single edit per object. For example,
// if the result of one rule updates a property to 'A', but another rule in
// the same action type updates the same object's property to 'B', the
// resulting edit would just update the property to 'B'."
//
// The compiler:
//   1. Processes each rule in order, generating preliminary edits
//   2. Merges all edits targeting the same object (same objectType + PK)
//   3. For conflicts on the same property, the LAST rule's value wins
//   4. Returns the final list of merged edits
// ---------------------------------------------------------------------------

import objectTypeService from "../services/objectTypeService";
import propertyService from "../services/propertyService";
import { getByApiName as getLinkType, resolvePropertyApiName, resolveObjectTypeApiName } from "../models/linkType";
import type { LinkTypeRow } from "../models/linkType";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source descriptor for resolving property values and object references. */
interface ValueSource {
  source: "parameter" | "static" | "currentTimestamp" | "currentUser";
  param?: string;
  value?: unknown;
}

/** A createObject rule. */
interface CreateObjectRule {
  type: "createObject";
  objectType: string;
  properties: Record<string, ValueSource>;
}

/** A modifyObject rule. */
interface ModifyObjectRule {
  type: "modifyObject";
  objectType: string;
  objectReference: ValueSource;
  properties: Record<string, ValueSource>;
}

/** A deleteObject rule. */
interface DeleteObjectRule {
  type: "deleteObject";
  objectType: string;
  objectReference: ValueSource;
}

/** An addLink rule. */
interface AddLinkRule {
  type: "addLink";
  linkType: string;
  sourceObject: ValueSource;
  targetObject: ValueSource;
}

/** A removeLink rule. */
interface RemoveLinkRule {
  type: "removeLink";
  linkType: string;
  sourceObject: ValueSource;
  targetObject: ValueSource;
}

/** Union of all supported rule types. */
type Rule = CreateObjectRule | ModifyObjectRule | DeleteObjectRule | AddLinkRule | RemoveLinkRule;

/** A single link edit entry appended to an object's edit. */
export interface LinkEdit {
  linkTypeApiName: string;
  targetPrimaryKey: string;
  operation: "add" | "remove";
}

/** A compiled edit for a single object. */
export interface CompiledEdit {
  objectType: string;
  primaryKey: string;
  operation: "create" | "update" | "delete";
  propertyValues: Record<string, unknown> | null;
  linkEdits: LinkEdit[];
}

/** The result of rule compilation. */
export interface CompileResult {
  edits: CompiledEdit[];
  errors: string[];
  affectedObjectCount: number;
}

/** Fetches an existing object from OpenSearch. */
export type ObjectFetcher = (
  objectType: string,
  primaryKey: string
) => Promise<Record<string, unknown> | null>;

/** Ambient context for the compilation. */
export interface ExecutionContext {
  executedBy: string;
  ontologyId: string;
}

// ---------------------------------------------------------------------------
// Internal accumulator for pre-merge edits
// ---------------------------------------------------------------------------

interface PreliminaryEdit {
  objectType: string;
  primaryKey: string;
  operation: "create" | "update" | "delete";
  propertyValues: Record<string, unknown> | null;
  linkEdits: LinkEdit[];
  ruleIndex: number; // for ordering during merge
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Compiles action rules into a list of Ontology edits.
 *
 * @param rules              - The rules array from the action type definition.
 * @param resolvedParameters - The validated and coerced parameters from the parameter validator.
 * @param objectFetcher      - Async function (objectType, primaryKey) => object | null.
 * @param executionContext   - { executedBy, ontologyId } ambient values.
 * @returns { edits, errors, affectedObjectCount }
 */
export async function compileRules(
  rules: Rule[],
  resolvedParameters: Record<string, unknown>,
  objectFetcher: ObjectFetcher,
  executionContext: ExecutionContext
): Promise<CompileResult> {
  const errors: string[] = [];
  const preliminaryEdits: PreliminaryEdit[] = [];

  // Process each rule in order
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];

    switch (rule.type) {
      case "createObject":
        await compileCreateObject(
          rule, resolvedParameters, objectFetcher, executionContext, i, preliminaryEdits, errors
        );
        break;

      case "modifyObject":
        await compileModifyObject(
          rule, resolvedParameters, objectFetcher, executionContext, i, preliminaryEdits, errors
        );
        break;

      case "deleteObject":
        await compileDeleteObject(
          rule, resolvedParameters, objectFetcher, executionContext, i, preliminaryEdits, errors
        );
        break;

      case "addLink":
        await compileLinkRule(
          rule, "add", resolvedParameters, objectFetcher, executionContext, i, preliminaryEdits, errors
        );
        break;

      case "removeLink":
        await compileLinkRule(
          rule, "remove", resolvedParameters, objectFetcher, executionContext, i, preliminaryEdits, errors
        );
        break;

      default:
        errors.push(`Unknown rule type '${(rule as any).type}' at index ${i}`);
    }
  }

  // If there were errors during individual rule compilation, still attempt
  // merge to report as many issues as possible (e.g., create+delete conflict)
  const merged = mergeEdits(preliminaryEdits, errors);

  return {
    edits: merged,
    errors,
    affectedObjectCount: merged.length,
  };
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single value source to a concrete value.
 * Returns undefined if the source references an optional parameter that
 * was not provided — the caller decides whether to skip or error.
 */
function resolveValue(
  source: ValueSource,
  resolvedParameters: Record<string, unknown>,
  executionContext: ExecutionContext
): unknown {
  switch (source.source) {
    case "parameter":
      return resolvedParameters[source.param!];

    case "static":
      return source.value;

    case "currentTimestamp":
      return new Date().toISOString();

    case "currentUser":
      return executionContext.executedBy;

    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// createObject compiler
// ---------------------------------------------------------------------------

async function compileCreateObject(
  rule: CreateObjectRule,
  resolvedParameters: Record<string, unknown>,
  objectFetcher: ObjectFetcher,
  executionContext: ExecutionContext,
  ruleIndex: number,
  edits: PreliminaryEdit[],
  errors: string[]
): Promise<void> {
  // 1. Resolve each property value
  const propertyValues: Record<string, unknown> = {};

  for (const [propName, source] of Object.entries(rule.properties)) {
    const value = resolveValue(source, resolvedParameters, executionContext);
    // If the parameter is undefined (optional and not provided), skip
    if (value === undefined) continue;
    propertyValues[propName] = value;
  }

  // 2. Determine the primary key property name
  const pkPropName = await getPrimaryKeyPropertyName(
    executionContext.ontologyId, rule.objectType, errors
  );
  if (!pkPropName) return; // error already added

  // 3. Verify PK is present in the resolved properties
  if (propertyValues[pkPropName] === undefined || propertyValues[pkPropName] === null) {
    errors.push(
      `createObject rule for type '${rule.objectType}' does not include the primary key property '${pkPropName}'`
    );
    return;
  }

  const primaryKey = String(propertyValues[pkPropName]);

  // 4. Check for duplicate primary key — the object must NOT already exist
  const existing = await objectFetcher(rule.objectType, primaryKey);
  if (existing) {
    errors.push(
      `createObject rule targets object '${primaryKey}' of type '${rule.objectType}' which already exists`
    );
    return;
  }

  // 5. Generate edit
  edits.push({
    objectType: rule.objectType,
    primaryKey,
    operation: "create",
    propertyValues,
    linkEdits: [],
    ruleIndex,
  });
}

// ---------------------------------------------------------------------------
// modifyObject compiler
// ---------------------------------------------------------------------------

async function compileModifyObject(
  rule: ModifyObjectRule,
  resolvedParameters: Record<string, unknown>,
  objectFetcher: ObjectFetcher,
  executionContext: ExecutionContext,
  ruleIndex: number,
  edits: PreliminaryEdit[],
  errors: string[]
): Promise<void> {
  // 1. Resolve object reference to get primary key
  const pkValue = resolveValue(rule.objectReference, resolvedParameters, executionContext);
  if (pkValue === undefined || pkValue === null) {
    errors.push(
      `modifyObject rule at index ${ruleIndex} could not resolve object reference`
    );
    return;
  }
  const primaryKey = String(pkValue);

  // 2. Verify object exists (check preliminaryEdits first for preceding create)
  const pendingCreate = edits.find(
    (e) =>
      e.objectType === rule.objectType &&
      e.primaryKey === primaryKey &&
      e.operation === "create"
  );
  if (!pendingCreate) {
    const existing = await objectFetcher(rule.objectType, primaryKey);
    if (!existing) {
      errors.push(
        `modifyObject rule targets object '${primaryKey}' of type '${rule.objectType}' which does not exist`
      );
      return;
    }
  }

  // 3. Resolve each property value
  const propertyValues: Record<string, unknown> = {};
  for (const [propName, source] of Object.entries(rule.properties)) {
    const value = resolveValue(source, resolvedParameters, executionContext);
    if (value === undefined) continue;
    propertyValues[propName] = value;
  }

  // 4. Generate edit
  edits.push({
    objectType: rule.objectType,
    primaryKey,
    operation: "update",
    propertyValues,
    linkEdits: [],
    ruleIndex,
  });
}

// ---------------------------------------------------------------------------
// deleteObject compiler
// ---------------------------------------------------------------------------

async function compileDeleteObject(
  rule: DeleteObjectRule,
  resolvedParameters: Record<string, unknown>,
  objectFetcher: ObjectFetcher,
  executionContext: ExecutionContext,
  ruleIndex: number,
  edits: PreliminaryEdit[],
  errors: string[]
): Promise<void> {
  // 1. Resolve object reference
  const pkValue = resolveValue(rule.objectReference, resolvedParameters, executionContext);
  if (pkValue === undefined || pkValue === null) {
    errors.push(
      `deleteObject rule at index ${ruleIndex} could not resolve object reference`
    );
    return;
  }
  const primaryKey = String(pkValue);

  // 2. Verify object exists
  const existing = await objectFetcher(rule.objectType, primaryKey);
  if (!existing) {
    errors.push(
      `deleteObject rule targets object '${primaryKey}' of type '${rule.objectType}' which does not exist`
    );
    return;
  }

  // 3. Generate edit
  edits.push({
    objectType: rule.objectType,
    primaryKey,
    operation: "delete",
    propertyValues: null,
    linkEdits: [],
    ruleIndex,
  });
}

// ---------------------------------------------------------------------------
// addLink / removeLink compiler
// ---------------------------------------------------------------------------

async function compileLinkRule(
  rule: AddLinkRule | RemoveLinkRule,
  linkOperation: "add" | "remove",
  resolvedParameters: Record<string, unknown>,
  objectFetcher: ObjectFetcher,
  executionContext: ExecutionContext,
  ruleIndex: number,
  edits: PreliminaryEdit[],
  errors: string[]
): Promise<void> {
  // 1. Resolve source and target object references
  const sourcePkValue = resolveValue(rule.sourceObject, resolvedParameters, executionContext);
  const targetPkValue = resolveValue(rule.targetObject, resolvedParameters, executionContext);

  if (sourcePkValue === undefined || sourcePkValue === null) {
    errors.push(
      `${rule.type} rule at index ${ruleIndex} could not resolve source object reference`
    );
    return;
  }
  if (targetPkValue === undefined || targetPkValue === null) {
    errors.push(
      `${rule.type} rule at index ${ruleIndex} could not resolve target object reference`
    );
    return;
  }

  const sourcePk = String(sourcePkValue);
  const targetPk = String(targetPkValue);

  // 2. Look up the link type definition
  const linkType: LinkTypeRow | null = await getLinkType(executionContext.ontologyId, rule.linkType);
  if (!linkType) {
    errors.push(
      `${rule.type} rule at index ${ruleIndex} references link type '${rule.linkType}' which does not exist`
    );
    return;
  }

  // 3. Resolve source and target object type api names from the link type
  let sourceObjectType: string;
  let targetObjectType: string;
  try {
    sourceObjectType = await resolveObjectTypeApiName(linkType.source_object_type);
    targetObjectType = await resolveObjectTypeApiName(linkType.target_object_type);
  } catch {
    errors.push(
      `${rule.type} rule at index ${ruleIndex}: could not resolve object types for link type '${rule.linkType}'`
    );
    return;
  }

  // 4. Handle based on cardinality
  if (linkType.cardinality === "MANY_TO_MANY") {
    // Generate a link edit entry on the source object
    const sourceEdit = findOrCreateEdit(edits, sourceObjectType, sourcePk, "update", ruleIndex);
    sourceEdit.linkEdits.push({
      linkTypeApiName: rule.linkType,
      targetPrimaryKey: targetPk,
      operation: linkOperation,
    });
  } else {
    // FK-based link: determine which side holds the FK
    // ONE_TO_MANY: source=1, target=N => FK is on the target side (target_property_id)
    // MANY_TO_ONE: source=N, target=1 => FK is on the source side (source_property_id)
    // ONE_TO_ONE: FK could be on either side — check which property_id is set

    let fkPropertyId: string | null = null;
    let fkObjectType: string;
    let fkObjectPk: string;
    let referencedPk: string;

    if (linkType.cardinality === "ONE_TO_MANY") {
      // FK on target side
      fkPropertyId = linkType.target_property_id;
      fkObjectType = targetObjectType;
      fkObjectPk = targetPk;
      referencedPk = sourcePk;
    } else if (linkType.cardinality === "MANY_TO_ONE") {
      // FK on source side
      fkPropertyId = linkType.source_property_id;
      fkObjectType = sourceObjectType;
      fkObjectPk = sourcePk;
      referencedPk = targetPk;
    } else {
      // ONE_TO_ONE: check which property is set
      if (linkType.source_property_id) {
        fkPropertyId = linkType.source_property_id;
        fkObjectType = sourceObjectType;
        fkObjectPk = sourcePk;
        referencedPk = targetPk;
      } else {
        fkPropertyId = linkType.target_property_id;
        fkObjectType = targetObjectType;
        fkObjectPk = targetPk;
        referencedPk = sourcePk;
      }
    }

    if (!fkPropertyId) {
      errors.push(
        `${rule.type} rule at index ${ruleIndex}: link type '${rule.linkType}' has no foreign key property configured`
      );
      return;
    }

    // Resolve the FK property api_name from the property_id
    let fkPropertyApiName: string;
    try {
      fkPropertyApiName = await resolvePropertyApiName(fkPropertyId);
    } catch {
      errors.push(
        `${rule.type} rule at index ${ruleIndex}: could not resolve foreign key property for link type '${rule.linkType}'`
      );
      return;
    }

    // Generate a modifyObject edit that sets or clears the FK property
    const fkValue = linkOperation === "add" ? referencedPk : null;
    const fkEdit = findOrCreateEdit(edits, fkObjectType, fkObjectPk, "update", ruleIndex);
    if (!fkEdit.propertyValues) {
      fkEdit.propertyValues = {};
    }
    fkEdit.propertyValues[fkPropertyApiName] = fkValue;
  }
}

// ---------------------------------------------------------------------------
// Edit merge step
// ---------------------------------------------------------------------------

/**
 * Merge all preliminary edits targeting the same object into a single edit.
 *
 * Merge rules:
 * - create + modify = create (merge property values, later wins)
 * - create + delete = ERROR (conflicting)
 * - modify + delete = delete (delete takes precedence)
 * - modify + modify = merge property values (later wins)
 * - Link edits: concatenate all link edits
 */
function mergeEdits(
  preliminaryEdits: PreliminaryEdit[],
  errors: string[]
): CompiledEdit[] {
  // Group edits by composite key: objectType + primaryKey
  const editMap = new Map<string, PreliminaryEdit[]>();

  for (const edit of preliminaryEdits) {
    const key = `${edit.objectType}::${edit.primaryKey}`;
    const group = editMap.get(key);
    if (group) {
      group.push(edit);
    } else {
      editMap.set(key, [edit]);
    }
  }

  const merged: CompiledEdit[] = [];

  for (const [_key, group] of editMap) {
    // Sort by rule index to ensure correct ordering
    group.sort((a, b) => a.ruleIndex - b.ruleIndex);

    const first = group[0];
    let finalOperation = first.operation;
    let finalPropertyValues: Record<string, unknown> | null = first.propertyValues
      ? { ...first.propertyValues }
      : null;
    let finalLinkEdits: LinkEdit[] = [...first.linkEdits];
    let hasCreate = first.operation === "create";
    let hasDelete = first.operation === "delete";

    for (let i = 1; i < group.length; i++) {
      const edit = group[i];

      if (edit.operation === "create") hasCreate = true;
      if (edit.operation === "delete") hasDelete = true;

      // Apply merge rules
      if (finalOperation === "create" && edit.operation === "delete") {
        // create + delete = conflict
        errors.push(
          `Conflicting rules: cannot create and delete the same object '${edit.primaryKey}' in one action`
        );
        finalOperation = "delete"; // mark but error is recorded
      } else if (finalOperation === "delete" && edit.operation === "create") {
        // delete + create = conflict (reverse order)
        errors.push(
          `Conflicting rules: cannot create and delete the same object '${edit.primaryKey}' in one action`
        );
      } else if (finalOperation === "create" && edit.operation === "update") {
        // create + modify = create with merged properties
        if (edit.propertyValues) {
          if (!finalPropertyValues) finalPropertyValues = {};
          Object.assign(finalPropertyValues, edit.propertyValues);
        }
        // operation stays "create"
      } else if (finalOperation === "update" && edit.operation === "create") {
        // modify + create (unusual but possible): treat as create
        finalOperation = "create";
        if (edit.propertyValues) {
          if (!finalPropertyValues) finalPropertyValues = {};
          Object.assign(finalPropertyValues, edit.propertyValues);
        }
      } else if (finalOperation === "update" && edit.operation === "delete") {
        // modify + delete = delete wins
        finalOperation = "delete";
        finalPropertyValues = null;
      } else if (finalOperation === "delete" && edit.operation === "update") {
        // delete + modify = delete still wins (modifications are moot)
        // operation stays "delete"
      } else if (finalOperation === "update" && edit.operation === "update") {
        // modify + modify = merge properties, later wins
        if (edit.propertyValues) {
          if (!finalPropertyValues) finalPropertyValues = {};
          Object.assign(finalPropertyValues, edit.propertyValues);
        }
      } else if (finalOperation === "create" && edit.operation === "create") {
        // create + create = merge properties (last wins per property)
        if (edit.propertyValues) {
          if (!finalPropertyValues) finalPropertyValues = {};
          Object.assign(finalPropertyValues, edit.propertyValues);
        }
      } else if (finalOperation === "delete" && edit.operation === "delete") {
        // delete + delete = still delete (idempotent)
      }

      // Concatenate link edits
      finalLinkEdits.push(...edit.linkEdits);
    }

    // Check for create+delete conflict across all edits in the group
    if (hasCreate && hasDelete) {
      // Error already added above during pairwise merge
    }

    merged.push({
      objectType: first.objectType,
      primaryKey: first.primaryKey,
      operation: finalOperation,
      propertyValues: finalOperation === "delete" ? null : finalPropertyValues,
      linkEdits: finalLinkEdits,
    });
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the primary key property api_name for an object type.
 * Returns null and adds an error if the lookup fails.
 */
async function getPrimaryKeyPropertyName(
  ontologyId: string,
  objectTypeApiName: string,
  errors: string[]
): Promise<string | null> {
  try {
    const result = await objectTypeService.getByApiName(ontologyId, objectTypeApiName);
    const objectType = result.objectType;
    const pkPropertyId = objectType.primary_key_property_id;

    if (!pkPropertyId) {
      errors.push(
        `Object type '${objectTypeApiName}' has no primary key property configured`
      );
      return null;
    }

    // Find the property with matching property_id among the returned properties
    const pkProp = result.properties.find(
      (p: any) => p.property_id === pkPropertyId
    );
    if (!pkProp) {
      errors.push(
        `Object type '${objectTypeApiName}' primary key property could not be resolved`
      );
      return null;
    }

    return pkProp.api_name;
  } catch (err: any) {
    errors.push(
      `Failed to look up object type '${objectTypeApiName}': ${err.message}`
    );
    return null;
  }
}

/**
 * Find an existing preliminary edit for the given object, or create a new
 * placeholder. Used by link rules to attach link edits or FK property
 * changes to the correct object's edit.
 */
function findOrCreateEdit(
  edits: PreliminaryEdit[],
  objectType: string,
  primaryKey: string,
  operation: "create" | "update" | "delete",
  ruleIndex: number
): PreliminaryEdit {
  const existing = edits.find(
    (e) => e.objectType === objectType && e.primaryKey === primaryKey
  );
  if (existing) return existing;

  const newEdit: PreliminaryEdit = {
    objectType,
    primaryKey,
    operation,
    propertyValues: {},
    linkEdits: [],
    ruleIndex,
  };
  edits.push(newEdit);
  return newEdit;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { compileRules };
