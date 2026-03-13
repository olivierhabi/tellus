// ---------------------------------------------------------------------------
// Schema Migration Validator (Task 26)
//
// Validates that changes to an action type schema are backward-compatible
// with existing audit log entries and pending edits. This is a safety net
// for the Ontology Manager UI — it warns about breaking changes but does
// NOT prevent them. The PUT endpoint calls this before applying updates
// and includes any warnings in the response body.
//
// Detections:
//   1. Removed required parameter (warning)
//   2. Parameter type change (warning)
//   3. Rule target object type change (breakingChange)
//   4. Primary key property change in createObject rule (breakingChange)
//   5. maxAffectedObjects reduction below recent usage (warning)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parameter definition as stored in the action type JSONB. */
interface ParameterDef {
  apiName: string;
  type: string;
  required?: boolean;
  [key: string]: unknown;
}

/** A rule definition as stored in the action type JSONB. */
interface RuleDef {
  type: string;
  objectType?: string;
  properties?: Record<string, PropertyMapping>;
  [key: string]: unknown;
}

/** A property mapping within a rule. */
interface PropertyMapping {
  source?: string;
  param?: string;
  value?: unknown;
  [key: string]: unknown;
}

/** The current action type schema (from DB row). */
export interface CurrentSchema {
  parameters: ParameterDef[];
  rules: RuleDef[];
  max_affected_objects: number;
}

/** The proposed updates (may be partial — only changed fields). */
export interface ProposedSchema {
  parameters?: ParameterDef[];
  rules?: RuleDef[];
  maxAffectedObjects?: number;
}

/** Recent execution statistics for detection #5. */
export interface RecentExecutionStats {
  maxAffectedCount: number;
}

/** Result of the schema migration validation. */
export interface MigrationValidationResult {
  safe: boolean;
  warnings: string[];
  breakingChanges: string[];
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Validates that changes to an action type schema are safe.
 *
 * @param currentSchema       - The current action type definition (from DB)
 * @param proposedSchema      - The proposed updates (partial — only changed fields)
 * @param recentExecutionStats - Optional stats from the audit log for detection #5
 * @returns { safe, warnings, breakingChanges }
 */
export function validateSchemaMigration(
  currentSchema: CurrentSchema,
  proposedSchema: ProposedSchema,
  recentExecutionStats: RecentExecutionStats | null = null
): MigrationValidationResult {
  const warnings: string[] = [];
  const breakingChanges: string[] = [];

  // Build arrays for efficient lookup
  const currentParams: ParameterDef[] = Array.isArray(currentSchema.parameters)
    ? currentSchema.parameters
    : [];
  const currentRules: RuleDef[] = Array.isArray(currentSchema.rules)
    ? currentSchema.rules
    : [];

  // -----------------------------------------------------------------------
  // Detection 1: Removed required parameter
  // -----------------------------------------------------------------------
  if (proposedSchema.parameters !== undefined) {
    const proposedParams: ParameterDef[] = Array.isArray(proposedSchema.parameters)
      ? proposedSchema.parameters
      : [];
    const proposedParamNames = new Set(
      proposedParams.map((p) => p.apiName)
    );

    for (const param of currentParams) {
      if (param.required && !proposedParamNames.has(param.apiName)) {
        warnings.push(
          `Required parameter '${param.apiName}' is being removed. ` +
            `Historical audit log entries referencing this parameter will ` +
            `still show the old parameter name.`
        );
      }
    }

    // -------------------------------------------------------------------
    // Detection 2: Parameter type change
    // -------------------------------------------------------------------
    const currentParamMap = new Map(
      currentParams.map((p) => [p.apiName, p])
    );

    for (const proposed of proposedParams) {
      const current = currentParamMap.get(proposed.apiName);
      if (current && current.type !== proposed.type) {
        warnings.push(
          `Parameter '${proposed.apiName}' type is changing from ` +
            `'${current.type}' to '${proposed.type}'. ` +
            `This may cause existing integrations to fail.`
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Detection 3: Rule target object type change
  // Detection 4: Primary key property change in createObject rule
  // -----------------------------------------------------------------------
  if (proposedSchema.rules !== undefined) {
    const proposedRules: RuleDef[] = Array.isArray(proposedSchema.rules)
      ? proposedSchema.rules
      : [];

    // Compare rules by index (positional comparison)
    const maxLen = Math.max(currentRules.length, proposedRules.length);

    for (let i = 0; i < maxLen; i++) {
      const currentRule = i < currentRules.length ? currentRules[i] : null;
      const proposedRule = i < proposedRules.length ? proposedRules[i] : null;

      if (!currentRule || !proposedRule) continue;

      // Only compare rules of the same type
      if (currentRule.type !== proposedRule.type) {
        // If the rule type itself changed, that's also a significant change
        // but the spec only asks for objectType changes — still report it
        // as a breaking change under detection 3
        if (currentRule.objectType && proposedRule.objectType) {
          breakingChanges.push(
            `Rule ${i} target changed from '${currentRule.objectType}' to ` +
              `'${proposedRule.objectType}'. This is a significant behavioral change.`
          );
        }
        continue;
      }

      // Detection 3: objectType change
      if (
        currentRule.objectType &&
        proposedRule.objectType &&
        currentRule.objectType !== proposedRule.objectType
      ) {
        breakingChanges.push(
          `Rule ${i} target changed from '${currentRule.objectType}' to ` +
            `'${proposedRule.objectType}'. This is a significant behavioral change.`
        );
      }

      // Detection 4: Primary key property change in createObject rule
      if (currentRule.type === "createObject" && proposedRule.type === "createObject") {
        const currentPkProp = findPrimaryKeyProperty(currentRule);
        const proposedPkProp = findPrimaryKeyProperty(proposedRule);

        if (
          currentPkProp !== null &&
          proposedPkProp !== null &&
          currentPkProp !== proposedPkProp
        ) {
          const objectType = proposedRule.objectType || currentRule.objectType || "unknown";
          breakingChanges.push(
            `createObject rule for '${objectType}' changed its primary key property. ` +
              `New objects will use a different identifier pattern.`
          );
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Detection 5: maxAffectedObjects reduction
  // -----------------------------------------------------------------------
  if (
    proposedSchema.maxAffectedObjects !== undefined &&
    proposedSchema.maxAffectedObjects < currentSchema.max_affected_objects
  ) {
    if (
      recentExecutionStats &&
      recentExecutionStats.maxAffectedCount > proposedSchema.maxAffectedObjects
    ) {
      warnings.push(
        `maxAffectedObjects reduced from ${currentSchema.max_affected_objects} to ` +
          `${proposedSchema.maxAffectedObjects}. Recent executions affected up to ` +
          `${recentExecutionStats.maxAffectedCount} objects and would fail under the new limit.`
      );
    }
  }

  return {
    safe: warnings.length === 0 && breakingChanges.length === 0,
    warnings,
    breakingChanges,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the primary key property name in a createObject rule.
 *
 * Heuristic: The first property in a createObject rule's properties map
 * is conventionally the primary key. This mirrors how Palantir's action
 * types work — the first property listed is typically the identifier.
 *
 * Returns the property name, or null if no properties exist.
 */
function findPrimaryKeyProperty(rule: RuleDef): string | null {
  if (!rule.properties || typeof rule.properties !== "object") {
    return null;
  }
  const keys = Object.keys(rule.properties);
  return keys.length > 0 ? keys[0] : null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { validateSchemaMigration };
