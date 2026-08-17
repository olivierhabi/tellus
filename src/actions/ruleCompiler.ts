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
import { query } from "../db";
import type { PoolClient } from "pg";
import {
  allocateGeneratedSequence,
  previewGeneratedSequence,
  type GeneratedSequenceSource,
} from "./generatedSequence";
import { incCounter } from "../services/funnel/metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source descriptor for resolving property values and object references. */
interface ValueSource {
  source: "parameter" | "static" | "currentTimestamp" | "generatedSequence" | "currentUser" | "writebackResponse";
  param?: string;
  value?: unknown;
  sequenceKey?: string;
  prefix?: string;
  padLength?: number;
  startAt?: number;
  // Phase 4 — writebackResponse value source fields.
  outputId?: string;
  path?: string;
}

/** A createObject rule. */
interface CreateObjectRule {
  type: "createObject";
  objectType: string;
  properties: Record<string, ValueSource>;
  links?: Array<{
    linkType: string;
    createdObjectSide: "source" | "target";
    otherObject: ValueSource;
  }>;
}

/** A modifyObject rule. */
interface ModifyObjectRule {
  type: "modifyObject";
  objectType: string;
  objectReference: ValueSource;
  properties: Record<string, ValueSource>;
}

/** A Foundry-style create-or-modify rule (upsert by object reference/PK). */
interface ModifyOrCreateObjectRule {
  type: "modifyOrCreateObject";
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

interface CreateInterfaceObjectRule {
  type: "createInterfaceObject";
  interfaceId: string;
  objectTypeParameter: string;
  properties: Record<string, ValueSource>;
}

interface ModifyInterfaceObjectRule {
  type: "modifyInterfaceObject";
  interfaceId: string;
  interfaceReference: ValueSource;
  properties: Record<string, ValueSource>;
}

interface DeleteInterfaceObjectRule {
  type: "deleteInterfaceObject";
  interfaceId: string;
  interfaceReference: ValueSource;
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
type Rule =
  | CreateObjectRule
  | ModifyObjectRule
  | ModifyOrCreateObjectRule
  | DeleteObjectRule
  | CreateInterfaceObjectRule
  | ModifyInterfaceObjectRule
  | DeleteInterfaceObjectRule
  | AddLinkRule
  | RemoveLinkRule
  | CreateInterfaceLinkRuleRuntime
  | DeleteInterfaceLinkRuleRuntime;

// Interface-link rules (Phase 2) — runtime-resolved into concrete
// addLink/removeLink rules by `interfaceLinkRules.resolveInterfaceLinkRule`
// before the existing `compileLinkRule` path applies them. The runtime
// types declared here mirror `actionRules.types.ts` but kept local to
// keep the rule compiler independent of the actionTypes route layer.
interface CreateInterfaceLinkRuleRuntime {
  type: "createInterfaceLink";
  interfaceLinkConstraint: string;
  interfaceId: string;
  source: { source: "parameter"; param: string; objectType?: string };
  target: { source: "parameter"; param: string; objectType?: string };
}
interface DeleteInterfaceLinkRuleRuntime {
  type: "deleteInterfaceLink";
  interfaceLinkConstraint: string;
  interfaceId: string;
  source: { source: "parameter"; param: string; objectType?: string };
  target: { source: "parameter"; param: string; objectType?: string };
}
type InterfaceLinkRuleRuntimeUnion = CreateInterfaceLinkRuleRuntime | DeleteInterfaceLinkRuleRuntime;

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
  /**
   * F-P3-12: optional branch UUID. The rule compiler does not use it
   * directly today, but the field is retained so the write-path
   * callers (`actionExecutor`) can pass it through for downstream
   * rule handlers and read-path helpers that need branch scoping.
   */
  branchId?: string;
  /**
   * Phase 4 — typed outputs map from the writeback pre-edit stage.
   * When an action type's `writeback_config` declares `outputBindings`,
   * the actionExecutor Stage 5 calls `executeWriteback` before the
   * compileRules path runs (for actions whose rule bodies use
   * `writebackResponse` value sources). The outputs map is keyed by
   * the binding's `outputId` and carries the JSONPointer-extracted
   * raw value from the validated response body.
   *
   * Phase 4 ships the abort-on-failure wire-up at the actionExecutor
   * stage; the typed outputs map propagated into `compileRules` here
   * lifts the `writebackResponse` ValueSource resolution next.
   */
  writebackOutputs?: Record<string, unknown>;
  /** Use the caller's transaction for generated identifiers when available. */
  transactionClient?: PoolClient;
  /** Validation/preview must never consume a durable sequence value. */
  previewGeneratedSequences?: boolean;
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

      case "modifyOrCreateObject":
        await compileModifyOrCreateObject(
          rule, resolvedParameters, objectFetcher, executionContext, i, preliminaryEdits, errors
        );
        break;

      case "deleteObject":
        await compileDeleteObject(
          rule, resolvedParameters, objectFetcher, executionContext, i, preliminaryEdits, errors
        );
        break;

      case "createInterfaceObject":
      case "modifyInterfaceObject":
      case "deleteInterfaceObject":
        await compileInterfaceObjectRule(
          rule,
          resolvedParameters,
          objectFetcher,
          executionContext,
          i,
          preliminaryEdits,
          errors,
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

      case "createInterfaceLink":
      case "deleteInterfaceLink":
        await compileInterfaceLinkRule(
          rule as InterfaceLinkRuleRuntimeUnion,
          resolvedParameters, objectFetcher, executionContext, i, preliminaryEdits, errors
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
  source: ValueSource | undefined | null,
  resolvedParameters: Record<string, unknown>,
  executionContext: ExecutionContext
): unknown {
  // Defensive: action-type rule payloads coming from seed data or imported
  // ontologies can be missing a ValueSource entirely (e.g. a modifyObject
  // rule with no `objectReference`). Return undefined so the caller records
  // a structured "could not resolve" error instead of the action handler
  // crashing with "Cannot read properties of undefined".
  if (!source || typeof source !== "object") return undefined;
  switch (source.source) {
    case "parameter":
      return resolvedParameters[source.param!];

    case "static":
      return source.value;

    case "currentTimestamp":
      return new Date().toISOString();

    case "currentUser":
      return executionContext.executedBy;

    case "writebackResponse": {
      // Phase 4 — read the typed outputs map from the writeback pre-edit
      // stage. The executor populates `executionContext.writebackOutputs`
      // key = outputId (per the action_type.writeback_config.outputBindings
      // JSONPointer extraction). The optional `path` field is a
      // JSONPointer into the per-output value (rare; most bindings
      // are 1:1). When the outputs map is absent (no writeback configured
      // — the canonical case for the existing 277 action types), we
      // return undefined — the compileRules-caller surfaces a "could
      // not resolve" structured error rather than crashing.
      const ws = source as unknown as { outputId?: string; path?: string };
      const outputs = executionContext.writebackOutputs;
      if (!outputs) return undefined;
      if (typeof ws.outputId !== "string") return undefined;
      const raw = outputs[ws.outputId];
      if (raw === undefined || raw === null) return undefined;
      if (!ws.path || ws.path === "" || ws.path === "/") return raw;
      // Local JSONPointer walk into the per-output raw value. Mirrors
      // the executor's lift path so save-time validation guarantees the
      // shape.
      return localJsonPointer(raw, ws.path);
    }

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
  const propertyBaseTypes = await getPropertyBaseTypes(
    executionContext.ontologyId,
    rule.objectType,
    errors,
  );
  if (!propertyBaseTypes) return;

  // 1. Resolve each property value
  const propertyValues: Record<string, unknown> = {};

  for (const [propName, source] of Object.entries(rule.properties)) {
    const value =
      source.source === "generatedSequence"
        ? executionContext.previewGeneratedSequences
          ? previewGeneratedSequence(source as GeneratedSequenceSource)
          : await allocateGeneratedSequence(
              executionContext.ontologyId,
              source as GeneratedSequenceSource,
              executionContext.transactionClient,
            )
        : resolveValue(source, resolvedParameters, executionContext);
    // If the parameter is undefined (optional and not provided), skip
    if (value === undefined) continue;
    propertyValues[propName] =
      source.source === "currentTimestamp" && propertyBaseTypes.get(propName) === "date"
        ? String(value).slice(0, 10)
        : value;
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

  let primaryKey = String(propertyValues[pkPropName]);

  // 4. Check for duplicate primary key — the object must NOT already exist
  // A generated identifier preview is deliberately non-reserving. Its
  // example value may already exist, which says nothing about whether the
  // next real allocation is available; do not turn that into a false
  // validation failure.
  let existing = executionContext.previewGeneratedSequences
    ? null
    : await objectFetcher(rule.objectType, primaryKey);
  const primaryKeySource = rule.properties[pkPropName];
  if (existing && primaryKeySource?.source === "generatedSequence") {
    const maxCollisionSkips = Math.max(
      1,
      Number.parseInt(process.env.ACTION_GENERATED_SEQUENCE_MAX_COLLISION_SKIPS ?? "1000", 10) || 1000,
    );
    let skipped = 0;
    while (existing && skipped < maxCollisionSkips) {
      primaryKey = await allocateGeneratedSequence(
        executionContext.ontologyId,
        primaryKeySource as GeneratedSequenceSource,
        executionContext.transactionClient,
      );
      propertyValues[pkPropName] = primaryKey;
      skipped += 1;
      existing = await objectFetcher(rule.objectType, primaryKey);
    }
    if (skipped > 0) {
      incCounter("tellus_action_generated_sequence_collisions_total", {
        object_type: rule.objectType,
      }, skipped);
    }
    if (existing) {
      errors.push(
        `Generated identifier sequence for type '${rule.objectType}' could not find an available value after ${maxCollisionSkips} collision(s)`,
      );
      return;
    }
  }
  if (existing) {
    errors.push(
      `createObject rule targets object '${primaryKey}' of type '${rule.objectType}' which already exists`
    );
    return;
  }

  // 5. Generate the object edit.
  edits.push({
    objectType: rule.objectType,
    primaryKey,
    operation: "create",
    propertyValues,
    linkEdits: [],
    ruleIndex,
  });

  // 6. Compile attached MANY_TO_MANY links through the same canonical link
  // path as standalone addLink rules. Save-time validation guarantees the
  // selected link is M2M and the created object occupies the declared side.
  for (const link of rule.links ?? []) {
    const createdObject = {
      source: "static" as const,
      value: primaryKey,
    };
    await compileLinkRule(
      {
        type: "addLink",
        linkType: link.linkType,
        sourceObject:
          link.createdObjectSide === "source"
            ? createdObject
            : link.otherObject,
        targetObject:
          link.createdObjectSide === "target"
            ? createdObject
            : link.otherObject,
      },
      "add",
      resolvedParameters,
      objectFetcher,
      executionContext,
      ruleIndex,
      edits,
      errors,
    );
  }
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
  // A Foundry bulk action supplies an object-reference list.  Expand the
  // declarative rule once per selected object; never stringify the list into
  // a comma-separated primary key.
  const primaryKeys = Array.isArray(pkValue) ? pkValue : [pkValue];
  if (primaryKeys.some((value) => typeof value !== "string" || !value.trim())) {
    errors.push(`modifyObject rule at index ${ruleIndex} resolved an invalid object reference list`);
    return;
  }

  // 3. Resolve each property value
  const propertyValues: Record<string, unknown> = {};
  for (const [propName, source] of Object.entries(rule.properties)) {
    const value = resolveValue(source, resolvedParameters, executionContext);
    if (value === undefined) continue;
    propertyValues[propName] = value;
  }

  // 3b. Reject primary key modifications. The v1 compiler previously mapped
  // the PK property verbatim into the update edit — silently RENAMING the
  // object's primary key (the v2 modifyObjectRule.ts:255 guard never ran on
  // this path). Mirror that guard here: a modifyObject rule may NOT write the
  // primary key property; identity comes from `objectReference` only.
  const pkPropName = await getPrimaryKeyPropertyName(
    executionContext.ontologyId, rule.objectType, errors
  );
  if (!pkPropName) return; // error already added
  if (propertyValues[pkPropName] !== undefined && primaryKeys.some((primaryKey) => propertyValues[pkPropName] !== primaryKey)) {
    errors.push(
      `Cannot modify the primary key property '${pkPropName}' of an existing object. ` +
      `Primary keys are immutable. To change an object's primary key, delete it and create a new object.`
    );
    return;
  }
  // The PK mapping, when present and equal to the target's PK, is a no-op —
  // drop it so a parameters→all-properties mapping doesn't write the key.
  delete propertyValues[pkPropName];

  // 4. Verify and generate one update for every selected object. Preserve the
  // selection order so previews and validation errors map back to the table.
  for (const primaryKey of primaryKeys) {
    // Check preliminary edits first for a preceding create in this action.
    const pendingCreate = edits.find(
      (e) => e.objectType === rule.objectType && e.primaryKey === primaryKey && e.operation === "create"
    );
    if (!pendingCreate) {
      const existing = await objectFetcher(rule.objectType, primaryKey);
      if (!existing) {
        errors.push(
          `modifyObject rule targets object '${primaryKey}' of type '${rule.objectType}' which does not exist`
        );
        continue;
      }
    }
    edits.push({
      objectType: rule.objectType,
      primaryKey,
      operation: "update",
      propertyValues,
      linkEdits: [],
      ruleIndex,
    });
  }
}

// ---------------------------------------------------------------------------
// modifyOrCreateObject compiler
// ---------------------------------------------------------------------------

/**
 * Foundry's "Create or modify object(s)" behavior: resolve the configured
 * object reference/primary key, update when it exists, otherwise create a new
 * object with that same key. The decision is made once during compilation so
 * the resulting action remains a single atomic ontology edit transaction.
 */
async function compileModifyOrCreateObject(
  rule: ModifyOrCreateObjectRule,
  resolvedParameters: Record<string, unknown>,
  objectFetcher: ObjectFetcher,
  executionContext: ExecutionContext,
  ruleIndex: number,
  edits: PreliminaryEdit[],
  errors: string[]
): Promise<void> {
  const reference = resolveValue(rule.objectReference, resolvedParameters, executionContext);
  if (reference === undefined || reference === null) {
    errors.push(
      `modifyOrCreateObject rule at index ${ruleIndex} could not resolve object reference`
    );
    return;
  }

  const primaryKey = String(reference);
  const propertyValues: Record<string, unknown> = {};
  for (const [propertyName, source] of Object.entries(rule.properties ?? {})) {
    const value = resolveValue(source, resolvedParameters, executionContext);
    if (value !== undefined) propertyValues[propertyName] = value;
  }

  const primaryKeyProperty = await getPrimaryKeyPropertyName(
    executionContext.ontologyId,
    rule.objectType,
    errors,
  );
  if (!primaryKeyProperty) return;

  const existing = await objectFetcher(rule.objectType, primaryKey);
  if (existing) {
    // Primary keys are immutable on update. The reference parameter selects
    // the object; all other mappings become the partial update payload.
    delete propertyValues[primaryKeyProperty];
    edits.push({
      objectType: rule.objectType,
      primaryKey,
      operation: "update",
      propertyValues,
      linkEdits: [],
      ruleIndex,
    });
    return;
  }

  // For the create branch, the object reference is also the user-entered PK.
  // This mirrors the creation wizard's "User-entered primary key" mode and
  // keeps imported rule definitions safe if they omit an explicit PK mapping.
  if (propertyValues[primaryKeyProperty] === undefined) {
    propertyValues[primaryKeyProperty] = reference;
  }
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

  // 2. Verify object exists (check pending creates first, like compileModifyObject).
  // A preceding create in the same action means the object will exist by the
  // time this delete runs. The merge step (mergeEdits) will correctly detect
  // the create+delete conflict and produce a single clean error, instead of
  // the double error ("does not exist" + "Conflicting rules") that would
  // occur if we queried objectFetcher for a not-yet-created object.
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
        `deleteObject rule targets object '${primaryKey}' of type '${rule.objectType}' which does not exist`
      );
      return;
    }
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

interface ResolvedInterfaceImplementation {
  objectType: string;
  propertyMapping: Record<string, string>;
}

async function resolveInterfaceImplementation(
  ontologyId: string,
  interfaceId: string,
  objectType: string,
): Promise<ResolvedInterfaceImplementation | null> {
  const result = await query(
    `SELECT ot.api_name AS object_type, oti.property_mapping
       FROM interface i
       JOIN object_type_interface oti ON oti.interface_id = i.interface_id
       JOIN object_type ot ON ot.object_type_id = oti.object_type_id
      WHERE i.ontology_id = $1 AND i.api_name = $2 AND ot.api_name = $3`,
    [ontologyId, interfaceId, objectType],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0] as {
    object_type: string;
    property_mapping: Record<string, string> | null;
  };
  return {
    objectType: row.object_type,
    propertyMapping: row.property_mapping ?? {},
  };
}

function resolveInterfaceReference(
  source: ValueSource,
  parameters: Record<string, unknown>,
  context: ExecutionContext,
): { objectType: string; primaryKey: string } | null {
  const value = resolveValue(source, parameters, context);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  if (
    typeof reference.objectType !== "string" ||
    typeof reference.primaryKey !== "string"
  ) {
    return null;
  }
  return {
    objectType: reference.objectType,
    primaryKey: reference.primaryKey,
  };
}

function mapInterfaceProperties(
  properties: Record<string, ValueSource>,
  implementation: ResolvedInterfaceImplementation,
  ruleIndex: number,
  errors: string[],
): Record<string, ValueSource> {
  const mapped: Record<string, ValueSource> = {};
  for (const [interfaceProperty, source] of Object.entries(properties)) {
    const concreteProperty = implementation.propertyMapping[interfaceProperty];
    if (!concreteProperty) {
      errors.push(
        `Interface rule at index ${ruleIndex} cannot resolve shared property '${interfaceProperty}' on implementing object type '${implementation.objectType}'.`,
      );
      continue;
    }
    mapped[concreteProperty] = source;
  }
  return mapped;
}

async function compileInterfaceObjectRule(
  rule:
    | CreateInterfaceObjectRule
    | ModifyInterfaceObjectRule
    | DeleteInterfaceObjectRule,
  resolvedParameters: Record<string, unknown>,
  objectFetcher: ObjectFetcher,
  executionContext: ExecutionContext,
  ruleIndex: number,
  edits: PreliminaryEdit[],
  errors: string[],
): Promise<void> {
  if (rule.type === "createInterfaceObject") {
    const selectedObjectType = resolvedParameters[rule.objectTypeParameter];
    if (typeof selectedObjectType !== "string" || selectedObjectType.length === 0) {
      errors.push(
        `createInterfaceObject rule at index ${ruleIndex} requires parameter '${rule.objectTypeParameter}' to select an implementing object type.`,
      );
      return;
    }
    const implementation = await resolveInterfaceImplementation(
      executionContext.ontologyId,
      rule.interfaceId,
      selectedObjectType,
    );
    if (!implementation) {
      errors.push(
        `Object type '${selectedObjectType}' does not implement interface '${rule.interfaceId}'.`,
      );
      return;
    }
    await compileCreateObject(
      {
        type: "createObject",
        objectType: implementation.objectType,
        properties: mapInterfaceProperties(
          rule.properties,
          implementation,
          ruleIndex,
          errors,
        ),
      },
      resolvedParameters,
      objectFetcher,
      executionContext,
      ruleIndex,
      edits,
      errors,
    );
    return;
  }

  const reference = resolveInterfaceReference(
    rule.interfaceReference,
    resolvedParameters,
    executionContext,
  );
  if (!reference) {
    errors.push(
      `${rule.type} rule at index ${ruleIndex} could not resolve an interface reference.`,
    );
    return;
  }
  const implementation = await resolveInterfaceImplementation(
    executionContext.ontologyId,
    rule.interfaceId,
    reference.objectType,
  );
  if (!implementation) {
    errors.push(
      `Object type '${reference.objectType}' does not implement interface '${rule.interfaceId}'.`,
    );
    return;
  }
  const referenceSource: ValueSource = {
    source: "static",
    value: reference.primaryKey,
  };
  if (rule.type === "deleteInterfaceObject") {
    await compileDeleteObject(
      {
        type: "deleteObject",
        objectType: implementation.objectType,
        objectReference: referenceSource,
      },
      resolvedParameters,
      objectFetcher,
      executionContext,
      ruleIndex,
      edits,
      errors,
    );
    return;
  }
  const concreteProperties = mapInterfaceProperties(
    rule.properties,
    implementation,
    ruleIndex,
    errors,
  );
  const primaryKeyProperty = await getPrimaryKeyPropertyName(
    executionContext.ontologyId,
    implementation.objectType,
    errors,
  );
  if (
    primaryKeyProperty &&
    Object.prototype.hasOwnProperty.call(concreteProperties, primaryKeyProperty)
  ) {
    errors.push(
      `modifyInterfaceObject rule at index ${ruleIndex} cannot modify primary key property '${primaryKeyProperty}'.`,
    );
    delete concreteProperties[primaryKeyProperty];
  }
  await compileModifyObject(
    {
      type: "modifyObject",
      objectType: implementation.objectType,
      objectReference: referenceSource,
      properties: concreteProperties,
    },
    resolvedParameters,
    objectFetcher,
    executionContext,
    ruleIndex,
    edits,
    errors,
  );
}

// ---------------------------------------------------------------------------
// addLink / removeLink compiler
// ---------------------------------------------------------------------------

/**
 * Interface-link rule compiler (Phase 2). Defers resolution of the
 * concrete link_type(s) implementing the interface contract to
 * `interfaceLinkRules.resolveInterfaceLinkRule`, then maps each returned
 * candidate into a concrete addLink or removeLink rule body and feeds it
 * back through the existing `compileLinkRule` path.
 *
 * Ambiguity (>1 candidate) on createInterfaceLink is a hard fail BEFORE
 * any edit is added — no ontology edit is applied to a non-deterministically-
 * resolved create. For deleteInterfaceLink, every candidate becomes a
 * removeLink, deterministic by link_type.api_name order (enforced inside
 * `interfaceLinkRules.buildConcreteLinkEditsFromCandidates`).
 */
async function compileInterfaceLinkRule(
  rule: InterfaceLinkRuleRuntimeUnion,
  resolvedParameters: Record<string, unknown>,
  objectFetcher: ObjectFetcher,
  executionContext: ExecutionContext,
  ruleIndex: number,
  edits: PreliminaryEdit[],
  errors: string[],
): Promise<void> {
  // The runtime source/target objects are resolved the SAME way as for
  // concrete link rules — they must point at object_reference parameters
  // whose object type the user declared on the action type. The interface-
  // link resolver then checks the source/target object types implement the
  // constraint's owning interface + the target interface (or fixed target
  // object type).
  const sourceVs = rule.source as unknown as ValueSource;
  const targetVs = rule.target as unknown as ValueSource;

  const sourcePkValue = resolveValue(sourceVs, resolvedParameters, executionContext);
  const targetPkValue = resolveValue(targetVs, resolvedParameters, executionContext);
  if (sourcePkValue === undefined || sourcePkValue === null) {
    errors.push(`${rule.type} rule at index ${ruleIndex} could not resolve source object reference.`);
    return;
  }
  if (targetPkValue === undefined || targetPkValue === null) {
    errors.push(`${rule.type} rule at index ${ruleIndex} could not resolve target object reference.`);
    return;
  }

  const sourceReference =
    typeof sourcePkValue === "object" && !Array.isArray(sourcePkValue)
      ? (sourcePkValue as Record<string, unknown>)
      : null;
  const targetReference =
    typeof targetPkValue === "object" && !Array.isArray(targetPkValue)
      ? (targetPkValue as Record<string, unknown>)
      : null;
  const runtimeRule: InterfaceLinkRuleRuntimeUnion = {
    ...rule,
    source: {
      ...rule.source,
      ...(typeof sourceReference?.objectType === "string"
        ? { objectType: sourceReference.objectType }
        : {}),
    },
    target: {
      ...rule.target,
      ...(typeof targetReference?.objectType === "string"
        ? { objectType: targetReference.objectType }
        : {}),
    },
  };
  const runtimeParameters = {
    ...resolvedParameters,
    ...(typeof sourceReference?.primaryKey === "string"
      ? { [rule.source.param]: sourceReference.primaryKey }
      : {}),
    ...(typeof targetReference?.primaryKey === "string"
      ? { [rule.target.param]: targetReference.primaryKey }
      : {}),
  };

  const { resolveInterfaceLinkRule, buildConcreteLinkEditsFromCandidates } = await import("./rules/interfaceLinkRules");
  const result = await resolveInterfaceLinkRule(executionContext.ontologyId, runtimeRule as any);

  switch (result.kind) {
    case "missing":
      errors.push(`${rule.type} rule at index ${ruleIndex}: interface_link_constraint '${result.constraintApiName}' not found.`);
      return;
    case "no_match":
      errors.push(`${rule.type} rule at index ${ruleIndex}: no concrete link_type implements the interface_link_constraint '${result.constraintApiName}' for the resolved source/target object types.`);
      return;
    case "invalid":
      for (const e of result.errors) errors.push(`${rule.type} rule at index ${ruleIndex}: ${e}`);
      return;
    case "ambiguous":
      errors.push(
        `${rule.type} rule at index ${ruleIndex}: ambiguous interface-link resolution. ` +
        `More than one concrete link_type satisfies the constraint '${rule.interfaceLinkConstraint}'. ` +
        `Failing before any edit is applied per the public behavioural spec. ` +
        `Candidates: ${result.candidates.map((c) => `${c.api_name} (${c.cardinality})`).join(", ")}.`,
      );
      return;
    case "ok":
      // Map each candidate to a concrete addLink/removeLink rule and feed
      // it back through compileLinkRule. The candidate edit bodies use
      // the runtime source/target pk values via the same parameter value
      // source as the original rule, so the existing compileLinkRule
      // path resolves them to the right PreliminaryEdit unchanged.
      const candidates = result.candidates;
      const concreteEdits = buildConcreteLinkEditsFromCandidates(runtimeRule, candidates);
      for (const edit of concreteEdits) {
        await compileLinkRule(
          edit as unknown as AddLinkRule | RemoveLinkRule,
          edit.type === "addLink" ? "add" : "remove",
          runtimeParameters,
          objectFetcher,
          executionContext,
          ruleIndex,
          edits,
          errors,
        );
      }
      return;
    default: {
      const _exhaustive: never = result;
      throw new Error(`Internal: unhandled interface-link resolver kind ${JSON.stringify(_exhaustive)}`);
    }
  }
}

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

    // fix(A5): reject FK writes that target the FK-bearing object's primary
    // key property. A misconfigured link type can point source_property_id/
    // target_property_id at the object's PK; the addLink rule would then
    // silently RENAME the FK-bearing object. Reject at compile (the same
    // PK-immutability contract enforced for modifyObject rules).
    const fkObjTypeDef = await objectTypeService.getByApiName(
      executionContext.ontologyId,
      fkObjectType,
    );
    const fkPkPropertyId = fkObjTypeDef.objectType.primary_key_property_id as string | null;
    if (fkPkPropertyId && fkPropertyId === fkPkPropertyId) {
      errors.push(
        `${rule.type} rule at index ${ruleIndex}: link type '${rule.linkType}' foreign-key property '${fkPropertyApiName}' is the primary key of object type '${fkObjectType}'; a link may not write the primary key.`
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
    let createRuleIndex =
      first.operation === "create" ? first.ruleIndex : undefined;
    let deleteRuleIndex =
      first.operation === "delete" ? first.ruleIndex : undefined;

    for (let i = 1; i < group.length; i++) {
      const edit = group[i];

      if (edit.operation === "create") {
        hasCreate = true;
        createRuleIndex ??= edit.ruleIndex;
      }
      if (edit.operation === "delete") {
        hasDelete = true;
        deleteRuleIndex ??= edit.ruleIndex;
      }

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
          `Invalid rule order at rules[${edit.ruleIndex}]: object '${edit.primaryKey}' was deleted by rules[${deleteRuleIndex ?? first.ruleIndex}] before this create. Move the delete rule after all creates and modifications.`
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
        errors.push(
          `Invalid rule order at rules[${edit.ruleIndex}]: object '${edit.primaryKey}' was deleted by rules[${deleteRuleIndex ?? first.ruleIndex}] before this modification. Move the delete rule after all modifications.`
        );
      } else if (finalOperation === "update" && edit.operation === "update") {
        // modify + modify = merge properties, later wins
        if (edit.propertyValues) {
          if (!finalPropertyValues) finalPropertyValues = {};
          Object.assign(finalPropertyValues, edit.propertyValues);
        }
      } else if (finalOperation === "create" && edit.operation === "create") {
        errors.push(
          `Duplicate object creation at rules[${edit.ruleIndex}]: object '${edit.primaryKey}' was already created by rules[${createRuleIndex ?? first.ruleIndex}]. Keep a single create rule and move later property mappings into it.`
        );
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
// Local JSONPointer (RFC 6901) walk for the writebackResponse value-source
// optional `path` field. Mirrors the per-binding extraction in
// `writebackExecutor.extractJsonPointer`.
// ---------------------------------------------------------------------------

function localJsonPointer(rootObj: unknown, pointer: string): unknown {
  if (!pointer || pointer === "" || pointer === "/") return rootObj;
  if (!pointer.startsWith("/")) {
    throw new Error(`JSONPointer '${pointer}' must start with '/'.`);
  }
  const segments = pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: any = rootObj;
  for (const seg of segments) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const idx = Number.parseInt(seg, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      current = current[seg];
    } else {
      return undefined;
    }
  }
  return current;
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

/** Resolve types once per create rule so date-valued system time is stored as
 * an ISO calendar date rather than a timestamp. */
async function getPropertyBaseTypes(
  ontologyId: string,
  objectTypeApiName: string,
  errors: string[],
): Promise<Map<string, string> | null> {
  try {
    const result = await objectTypeService.getByApiName(ontologyId, objectTypeApiName);
    return new Map(
      result.properties.map((property: any) => [
        property.api_name as string,
        String(property.base_type ?? "").toLowerCase(),
      ]),
    );
  } catch (err: any) {
    errors.push(
      `Failed to look up object type '${objectTypeApiName}': ${err.message}`,
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
