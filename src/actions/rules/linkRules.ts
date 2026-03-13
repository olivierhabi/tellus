// ---------------------------------------------------------------------------
// AddLink / RemoveLink Rule Handlers
//
// Manage many-to-many relationships between objects. For FK-based links
// (ONE_TO_MANY, MANY_TO_ONE), linking is converted to a modifyObject edit
// that sets/clears the FK property. For MANY_TO_MANY links, a link edit
// record is produced for the link_edit join table.
//
// Per Palantir docs: "You can also create objects and linked many-to-many
// at the same time." — if an earlier rule in the same action creates an
// object, the link rule can reference it via pendingEdits even though it
// doesn't yet exist in OpenSearch.
// ---------------------------------------------------------------------------

import {
  getByApiName as getLinkType,
  resolveObjectTypeApiName,
  resolvePropertyApiName,
} from "../../models/linkType";
import type { LinkTypeRow } from "../../models/linkType";
import { objectExists } from "../objectChecker";
import { query } from "../../db";
import type { RuleContext } from "./createObjectRule";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A value source descriptor. */
interface ValueSource {
  source: "parameter" | "static" | "currentTimestamp" | "currentUser";
  param?: string;
  value?: unknown;
}

/** An addLink rule definition. */
export interface AddLinkRuleDef {
  type: "addLink";
  linkType: string;
  sourceObject: ValueSource;
  targetObject: ValueSource;
}

/** A removeLink rule definition. */
export interface RemoveLinkRuleDef {
  type: "removeLink";
  linkType: string;
  sourceObject: ValueSource;
  targetObject: ValueSource;
}

/** A many-to-many link edit record. */
export interface LinkEditRecord {
  linkTypeApiName: string;
  sourcePrimaryKey: string;
  targetPrimaryKey: string;
  operation: "add" | "remove";
}

/** A FK-based property edit record. */
export interface FkEdit {
  objectType: string;
  primaryKey: string;
  operation: "update";
  propertyValues: Record<string, unknown>;
  systemProperties: { __lastModified: string; __editedBy: string };
  linkEdits: unknown[];
}

/** A pending edit from earlier rules in the same action. */
interface PendingEdit {
  objectType: string;
  primaryKey: string;
  operation: string;
  [key: string]: unknown;
}

/** Result of processAddLinkRule / processRemoveLinkRule. */
export interface LinkRuleResult {
  linkEdit: LinkEditRecord | null;
  edit: FkEdit | null;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// addLink
// ---------------------------------------------------------------------------

/**
 * Processes an addLink rule.
 *
 * @param rule               - The addLink rule definition
 * @param resolvedParameters - Validated parameters
 * @param context            - { executedBy, ontologyId, schemaCache? }
 * @param pendingEdits       - Edits produced by earlier rules in the same action
 * @returns { linkEdit, edit, errors, warnings }
 */
export async function processAddLinkRule(
  rule: AddLinkRuleDef,
  resolvedParameters: Record<string, unknown>,
  context: RuleContext,
  pendingEdits: PendingEdit[]
): Promise<LinkRuleResult> {
  return processLinkRule(rule, "add", resolvedParameters, context, pendingEdits);
}

// ---------------------------------------------------------------------------
// removeLink
// ---------------------------------------------------------------------------

/**
 * Processes a removeLink rule.
 *
 * @param rule               - The removeLink rule definition
 * @param resolvedParameters - Validated parameters
 * @param context            - { executedBy, ontologyId, schemaCache? }
 * @param pendingEdits       - Edits produced by earlier rules in the same action
 * @returns { linkEdit, edit, errors, warnings }
 */
export async function processRemoveLinkRule(
  rule: RemoveLinkRuleDef,
  resolvedParameters: Record<string, unknown>,
  context: RuleContext,
  pendingEdits: PendingEdit[]
): Promise<LinkRuleResult> {
  return processLinkRule(rule, "remove", resolvedParameters, context, pendingEdits);
}

// ---------------------------------------------------------------------------
// Shared implementation
// ---------------------------------------------------------------------------

async function processLinkRule(
  rule: AddLinkRuleDef | RemoveLinkRuleDef,
  operation: "add" | "remove",
  resolvedParameters: Record<string, unknown>,
  context: RuleContext,
  pendingEdits: PendingEdit[]
): Promise<LinkRuleResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ruleLabel = operation === "add" ? "addLink" : "removeLink";

  // -----------------------------------------------------------------
  // Step 1: Load link type definition
  // -----------------------------------------------------------------
  let linkType: LinkTypeRow | null;
  try {
    linkType = await getLinkType(context.ontologyId, rule.linkType);
  } catch {
    linkType = null;
  }

  if (!linkType) {
    return {
      linkEdit: null,
      edit: null,
      errors: [
        `${ruleLabel} rule references link type '${rule.linkType}' which does not exist`,
      ],
      warnings: [],
    };
  }

  // Resolve source and target object type api names
  let sourceObjectType: string;
  let targetObjectType: string;
  try {
    sourceObjectType = await resolveObjectTypeApiName(linkType.source_object_type);
    targetObjectType = await resolveObjectTypeApiName(linkType.target_object_type);
  } catch {
    return {
      linkEdit: null,
      edit: null,
      errors: [
        `${ruleLabel} rule: could not resolve object types for link type '${rule.linkType}'`,
      ],
      warnings: [],
    };
  }

  // -----------------------------------------------------------------
  // Step 2: Resolve source and target object references
  // -----------------------------------------------------------------
  const sourcePkValue = resolveValue(rule.sourceObject, resolvedParameters, context);
  const targetPkValue = resolveValue(rule.targetObject, resolvedParameters, context);

  if (sourcePkValue === undefined || sourcePkValue === null) {
    return {
      linkEdit: null,
      edit: null,
      errors: [
        `${ruleLabel} rule could not resolve source object reference`,
      ],
      warnings: [],
    };
  }
  if (targetPkValue === undefined || targetPkValue === null) {
    return {
      linkEdit: null,
      edit: null,
      errors: [
        `${ruleLabel} rule could not resolve target object reference`,
      ],
      warnings: [],
    };
  }

  const sourcePk = String(sourcePkValue);
  const targetPk = String(targetPkValue);

  // -----------------------------------------------------------------
  // Step 3: Verify both objects exist (or are being created)
  // -----------------------------------------------------------------
  const sourceExistsInOs = await safeObjectExists(sourceObjectType, sourcePk);
  const targetExistsInOs = await safeObjectExists(targetObjectType, targetPk);

  const sourceInPending = pendingEdits.some(
    (e) =>
      e.objectType === sourceObjectType &&
      e.primaryKey === sourcePk &&
      e.operation === "create"
  );
  const targetInPending = pendingEdits.some(
    (e) =>
      e.objectType === targetObjectType &&
      e.primaryKey === targetPk &&
      e.operation === "create"
  );

  if (!sourceExistsInOs && !sourceInPending) {
    errors.push(
      `${ruleLabel} rule: source object '${sourcePk}' of type '${sourceObjectType}' does not exist`
    );
  }
  if (!targetExistsInOs && !targetInPending) {
    errors.push(
      `${ruleLabel} rule: target object '${targetPk}' of type '${targetObjectType}' does not exist`
    );
  }

  if (errors.length > 0) {
    return { linkEdit: null, edit: null, errors, warnings: [] };
  }

  // -----------------------------------------------------------------
  // Step 4: Handle based on cardinality
  // -----------------------------------------------------------------
  if (linkType.cardinality === "MANY_TO_MANY") {
    return handleManyToMany(
      linkType,
      sourcePk,
      targetPk,
      operation,
      ruleLabel,
      warnings
    );
  }

  // FK-based link
  return handleFkLink(
    linkType,
    sourceObjectType,
    targetObjectType,
    sourcePk,
    targetPk,
    operation,
    ruleLabel,
    context,
    warnings
  );
}

// ---------------------------------------------------------------------------
// MANY_TO_MANY handler
// ---------------------------------------------------------------------------

async function handleManyToMany(
  linkType: LinkTypeRow,
  sourcePk: string,
  targetPk: string,
  operation: "add" | "remove",
  ruleLabel: string,
  warnings: string[]
): Promise<LinkRuleResult> {
  if (operation === "add") {
    // Check for duplicate: is this link already active?
    try {
      const netState = await getLinkNetState(
        linkType.api_name,
        sourcePk,
        targetPk
      );
      if (netState > 0) {
        warnings.push(
          `Link already exists between '${sourcePk}' and '${targetPk}' via '${linkType.api_name}'`
        );
      }
    } catch {
      // Best-effort duplicate check
    }
  } else {
    // remove: verify the link actually exists
    try {
      const netState = await getLinkNetState(
        linkType.api_name,
        sourcePk,
        targetPk
      );
      if (netState <= 0) {
        return {
          linkEdit: null,
          edit: null,
          errors: [
            `removeLink rule: no link exists between '${sourcePk}' and '${targetPk}' via '${linkType.api_name}'`,
          ],
          warnings: [],
        };
      }
    } catch {
      // If we can't verify, proceed anyway (the link_edit will be recorded)
    }
  }

  return {
    linkEdit: {
      linkTypeApiName: linkType.api_name,
      sourcePrimaryKey: sourcePk,
      targetPrimaryKey: targetPk,
      operation,
    },
    edit: null,
    errors: [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// FK-based link handler (ONE_TO_MANY, MANY_TO_ONE, ONE_TO_ONE)
// ---------------------------------------------------------------------------

async function handleFkLink(
  linkType: LinkTypeRow,
  sourceObjectType: string,
  targetObjectType: string,
  sourcePk: string,
  targetPk: string,
  operation: "add" | "remove",
  ruleLabel: string,
  context: RuleContext,
  warnings: string[]
): Promise<LinkRuleResult> {
  // Determine which side holds the FK
  // ONE_TO_MANY: source=1, target=N → FK on target side (target_property_id)
  // MANY_TO_ONE: source=N, target=1 → FK on source side (source_property_id)
  // ONE_TO_ONE: check which property_id is set

  let fkPropertyId: string | null = null;
  let fkObjectType: string;
  let fkObjectPk: string;
  let referencedPk: string;

  if (linkType.cardinality === "ONE_TO_MANY") {
    fkPropertyId = linkType.target_property_id;
    fkObjectType = targetObjectType;
    fkObjectPk = targetPk;
    referencedPk = sourcePk;
  } else if (linkType.cardinality === "MANY_TO_ONE") {
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
    return {
      linkEdit: null,
      edit: null,
      errors: [
        `${ruleLabel} rule: link type '${linkType.api_name}' has no foreign key property configured`,
      ],
      warnings: [],
    };
  }

  // Resolve FK property api_name
  let fkPropertyApiName: string;
  try {
    fkPropertyApiName = await resolvePropertyApiName(fkPropertyId);
  } catch {
    return {
      linkEdit: null,
      edit: null,
      errors: [
        `${ruleLabel} rule: could not resolve foreign key property for link type '${linkType.api_name}'`,
      ],
      warnings: [],
    };
  }

  // For add: set FK to the referenced PK
  // For remove: set FK to null (clear the relationship)
  const fkValue = operation === "add" ? referencedPk : null;
  const now = new Date().toISOString();

  return {
    linkEdit: null,
    edit: {
      objectType: fkObjectType,
      primaryKey: fkObjectPk,
      operation: "update",
      propertyValues: { [fkPropertyApiName]: fkValue },
      systemProperties: {
        __lastModified: now,
        __editedBy: context.executedBy,
      },
      linkEdits: [],
    },
    errors: [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a value source to a concrete value.
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
 * Check object existence without throwing on connection errors.
 * Returns false on any error (the caller handles pending edits separately).
 */
async function safeObjectExists(
  objectType: string,
  primaryKey: string
): Promise<boolean> {
  try {
    return await objectExists(objectType, primaryKey);
  } catch {
    return false;
  }
}

/**
 * Get the net state of a many-to-many link (add count minus remove count).
 * A positive value means the link is currently active.
 */
async function getLinkNetState(
  linkTypeApiName: string,
  sourcePk: string,
  targetPk: string
): Promise<number> {
  const result = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN operation = 'add' THEN 1 ELSE -1 END), 0)::int AS net
     FROM link_edit
     WHERE link_type_api_name = $1
       AND source_primary_key = $2
       AND target_primary_key = $3`,
    [linkTypeApiName, sourcePk, targetPk]
  );
  return result.rows[0]?.net ?? 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { processAddLinkRule, processRemoveLinkRule };
