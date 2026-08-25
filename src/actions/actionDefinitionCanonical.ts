// ---------------------------------------------------------------------------
// Canonical Action-Type Definition (pin identity)
//
// The semantic, display-metadata-free canonical form of an action-type
// definition. TWO consumers must agree bit-for-bit:
//
//   1. hashActionDefinition()        — the pin hash written to
//      action_type.definition_hash and stamped onto Automate effect pins
//      (draft.effects[*].definitionHash).
//   2. classifyActionDefinitionChange() — structural compatible/breaking
//      classification between a pinned and the current definition.
//
// CANONICALIZATION RULES (deterministic across object key order and DB
// round-trips):
//   • object keys sorted recursively (never rely on JSONB key order),
//   • parameters sorted by apiName; each reduced to the semantic subset
//     { apiName, dataType, required, defaultValue } — displayName,
//     description, rid, icon etc. are EXCLUDED,
//     `dataType` normalized from the column's `type` field, trimmed +
//     lowercased,
//   • undefined normalized to null,
//   • `ruleSignatures` = one reduced signature per rule (see
//     extractRuleSignature) — rules matched by ruleId (falling back to
//     array position) during classification; full rule payloads still feed
//     the hash so ANY rule content change makes pins non-identical.
//
// SCOPE NOTE: the hash covers the same field set the
// trg_action_type_definition_version bump trigger watches (parameters,
// rules, submission_criteria, side_effects, writeback_config,
// semantics_version, execution_mode, delete_policy) PLUS function_config.
// The hash MUST be a superset of the trigger-watched fields, otherwise an
// edit that bumps definition_version could leave the hash unchanged and a
// pin would pass "identical" while semantics actually moved.
// ---------------------------------------------------------------------------

/** Loose input shape accepted from either a TS-side def or a DB row. */
export interface ActionDefinitionInput {
  parameters?: unknown;
  rules?: unknown;
  submissionCriteria?: unknown;
  sideEffects?: unknown;
  writebackConfig?: unknown;
  functionConfig?: unknown;
  semanticsVersion?: number | null;
  executionMode?: string | null;
  deletePolicy?: string | null;
}

export interface CanonicalActionParameter {
  apiName: string;
  dataType: string;
  required: boolean;
  defaultValue: unknown;
}

export interface CanonicalActionDefinition {
  parameters: CanonicalActionParameter[];
  /** Full canonicalized rule payloads (sorted keys) — hash input. */
  rules: unknown[];
  /** Reduced rule signatures — classification input. */
  ruleSignatures: ReturnType<typeof extractRuleSignature>[];
  submissionCriteria: unknown;
  sideEffects: unknown;
  writebackConfig: unknown;
  functionConfig: unknown;
  semanticsVersion: number | null;
  executionMode: string | null;
  deletePolicy: string | null;
}

/**
 * Recursively canonicalize a JSON value: object keys sorted, `undefined`
 * → `null`. Arrays keep order (callers sort where order is not semantic).
 */
export function canonicalizeJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalizeJsonValue(
      (value as Record<string, unknown>)[key],
    );
  }
  return sorted;
}

/** Deterministic string of a JSON value (sorted keys, no whitespace). */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function normalizeDataType(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "string";
}

export function canonicalizeActionParameter(
  parameter: unknown,
): CanonicalActionParameter {
  const record =
    parameter && typeof parameter === "object"
      ? (parameter as Record<string, unknown>)
      : {};
  return {
    apiName: typeof record.apiName === "string" ? record.apiName : "",
    // Accept the DB shape (`type`) OR an already-canonical shape
    // (`dataType`) so canonicalize(canonicalize(x)) === canonicalize(x) —
    // history snapshots store the canonical form and are re-classified.
    dataType: normalizeDataType(record.type ?? record.dataType),
    required: record.required === true,
    // Only `defaultValue` participates; `null` and "absent" are equivalent.
    defaultValue: record.defaultValue ?? null,
  };
}

/**
 * The part of a rule that constitutes its *interface signature*: identity
 * (ruleId), rule kind, and referenced ontology artifacts. Parameter
 * bindings / property payloads inside the rule are intentionally EXCLUDED —
 * editing a binding keeps the signature (compatible), changing the rule
 * kind or its target object/link/event changes it (breaking). Unknown rule
 * kinds fall back to the full canonicalized rule: better for an unknown
 * future rule type to classify based on full content than to miss a
 * structural change.
 */
export function extractRuleSignature(rule: unknown): Record<string, unknown> {
  if (!rule || typeof rule !== "object") {
    return { type: "unknown" };
  }
  const record = rule as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";
  const signature: Record<string, unknown> = { type };
  if (typeof record.ruleId === "string") signature.ruleId = record.ruleId;
  // Referenced ontology artifacts per rule family.
  for (const key of [
    "objectType",
    "linkType",
    "eventType",
    "interfaceType",
    "functionRid",
  ] as const) {
    if (typeof record[key] === "string") signature[key] = record[key];
  }
  return canonicalizeJsonValue(signature) as Record<string, unknown>;
}

/**
 * Build the canonical definition. Never throws: non-conforming shapes are
 * reduced to their canonical fallback (empty arrays / nulls) — a malformed
 * definition must produce a stable "unknown" pin rather than crash
 * validation.
 */
export function canonicalizeActionDefinition(
  input: ActionDefinitionInput,
): CanonicalActionDefinition {
  const safe =
    input && typeof input === "object" ? input : ({} as ActionDefinitionInput);
  const rawParameters = Array.isArray(safe.parameters)
    ? safe.parameters
    : [];
  const parameters = rawParameters
    .map(canonicalizeActionParameter)
    .sort((a, b) => a.apiName.localeCompare(b.apiName));
  const rawRules = Array.isArray(safe.rules) ? safe.rules : [];
  return {
    parameters,
    rules: rawRules.map(canonicalizeJsonValue),
    ruleSignatures: rawRules.map(extractRuleSignature),
    submissionCriteria: canonicalizeJsonValue(safe.submissionCriteria ?? null),
    sideEffects: canonicalizeJsonValue(safe.sideEffects ?? null),
    writebackConfig: canonicalizeJsonValue(safe.writebackConfig ?? null),
    functionConfig: canonicalizeJsonValue(safe.functionConfig ?? null),
    semanticsVersion:
      typeof safe.semanticsVersion === "number"
        ? safe.semanticsVersion
        : null,
    executionMode:
      typeof safe.executionMode === "string" ? safe.executionMode : null,
    deletePolicy:
      typeof safe.deletePolicy === "string" ? safe.deletePolicy : null,
  };
}

/** Stable string the pin hash is computed over. */
export function canonicalActionDefinitionString(
  input: ActionDefinitionInput,
): string {
  const canonical = canonicalizeActionDefinition(input);
  return JSON.stringify({
    parameters: canonical.parameters,
    rules: canonical.rules,
    submissionCriteria: canonical.submissionCriteria,
    sideEffects: canonical.sideEffects,
    writebackConfig: canonical.writebackConfig,
    functionConfig: canonical.functionConfig,
    semanticsVersion: canonical.semanticsVersion,
    executionMode: canonical.executionMode,
    deletePolicy: canonical.deletePolicy,
  });
}

/** Convenience for call sites holding a raw DB `action_type` row. */
export function actionDefinitionInputFromRow(row: {
  parameters?: unknown;
  rules?: unknown;
  submission_criteria?: unknown;
  side_effects?: unknown;
  writeback_config?: unknown;
  function_config?: unknown;
  semantics_version?: number | null;
  execution_mode?: string | null;
  delete_policy?: string | null;
}): ActionDefinitionInput {
  return {
    parameters: row.parameters,
    rules: row.rules,
    submissionCriteria: row.submission_criteria,
    sideEffects: row.side_effects,
    writebackConfig: row.writeback_config,
    functionConfig: row.function_config,
    semanticsVersion: row.semantics_version,
    executionMode: row.execution_mode,
    deletePolicy: row.delete_policy,
  };
}
