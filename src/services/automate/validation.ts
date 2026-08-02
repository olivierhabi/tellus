import type { Pool, PoolClient } from "pg";
import {
  AutomationDraftSchema,
  type AutomationDraft,
  type EffectDraft,
  type ValidationIssue,
  type ValidationResult,
  type ValueBinding,
  type ThresholdExpression,
} from "./contracts";
import {
  CONDITION_COMPATIBILITY,
  supportsEvaluationMode,
  type EvaluationMode,
} from "./compatibility";
import { validateSchedule } from "./schedule";
import { ObjectSet } from "../oss/objectSetDefinition";
import { readCanonicalSignature } from "../functions/canonicalSignature";
import {
  unsupportedConfiguredParameters,
  validateConstantValue,
} from "../functions/parameterValidation";
import { executionPolicy } from "../functions/executionPolicy";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

function issue(
  code: string,
  message: string,
  step: ValidationIssue["step"],
  path?: string,
  effectId?: string,
  severity: ValidationIssue["severity"] = "error",
): ValidationIssue {
  return { code, message, severity, step, path, effectId };
}

function collectBindings(effect: EffectDraft): ValueBinding[] {
  if (effect.type === "notification") {
    return [
      ...effect.recipients.dynamic,
      ...(effect.content.kind === "function"
        ? Object.values(effect.content.parameters)
        : []),
    ];
  }
  return Object.values(effect.parameters);
}

function validateThresholdExpression(
  expression: ThresholdExpression,
  issues: ValidationIssue[],
  depth = 0,
  count = { value: 0 },
): void {
  count.value += 1;
  if (depth > 10 || count.value > 500) {
    issues.push(
      issue(
        "THRESHOLD_EXPRESSION_TOO_COMPLEX",
        "Threshold expressions are limited to 10 nested levels and 500 nodes.",
        "condition",
        "condition.expression",
      ),
    );
    return;
  }
  if (expression.kind === "group") {
    if (expression.children.length === 0) {
      issues.push(
        issue(
          "THRESHOLD_EXPRESSION_REQUIRED",
          "Each logical group must contain at least one condition.",
          "condition",
          "condition.expression",
        ),
      );
    }
    expression.children.forEach((child) =>
      validateThresholdExpression(child, issues, depth + 1, count),
    );
    return;
  }
  if (expression.kind === "function") {
    if (
      !expression.functionRid ||
      !expression.repositoryRid ||
      !expression.apiName ||
      !expression.branch ||
      !expression.version ||
      !expression.artifactSha256
    ) {
      issues.push(
        issue(
          "THRESHOLD_FUNCTION_REQUIRED",
          "Select and pin a published Boolean query Function.",
          "condition",
          "condition.expression",
        ),
      );
    }
    for (const [parameter, binding] of Object.entries(expression.parameters)) {
      if (binding.kind !== "constant") {
        issues.push(
          issue(
            "THRESHOLD_FUNCTION_BINDING_UNSUPPORTED",
            "Threshold Function parameters must use constants because no condition output exists before evaluation.",
            "condition",
            `condition.expression.parameters.${parameter}`,
          ),
        );
      }
    }
    return;
  }
  if (!ObjectSet.safeParse(expression.objectSet).success) {
    issues.push(
      issue(
        "THRESHOLD_OBJECT_SET_INVALID",
        "Configure a valid canonical object set for every metric.",
        "condition",
        "condition.expression",
      ),
    );
  }
  if (
    expression.aggregation !== "count" &&
    !expression.propertyApiName
  ) {
    issues.push(
      issue(
        "THRESHOLD_PROPERTY_REQUIRED",
        `${expression.aggregation} requires a numeric property.`,
        "condition",
        "condition.expression",
      ),
    );
  }
}

export function validateAutomationDraft(raw: unknown): ValidationResult {
  const parsed = AutomationDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((zodIssue) =>
        issue(
          "AUTOMATION_DEFINITION_INVALID",
          zodIssue.message,
          zodIssue.path[0] === "condition"
            ? "condition"
            : zodIssue.path[0] === "settings"
              ? "settings"
              : zodIssue.path[0] === "effects"
                ? "effects"
                : "summary",
          zodIssue.path.join("."),
        ),
      ),
    };
  }

  const draft = parsed.data;
  const issues: ValidationIssue[] = [];
  const compatibility = CONDITION_COMPATIBILITY[draft.condition.type];
  if (!compatibility.available) {
    issues.push(
      issue(
        "CONDITION_UNAVAILABLE",
        compatibility.unavailableReason ??
          `${draft.condition.type} is unavailable.`,
        "condition",
        "condition.type",
      ),
    );
  }
  if ("evaluationMode" in draft.condition) {
    const mode = draft.condition.evaluationMode as EvaluationMode;
    if (!supportsEvaluationMode(draft.condition.type, mode)) {
      issues.push(
        issue(
          "CONDITION_MODE_UNSUPPORTED",
          `${draft.condition.type} does not support ${mode} evaluation.`,
          "time",
          "condition.evaluationMode",
        ),
      );
    }
  }
  if ("schedule" in draft.condition && draft.condition.schedule) {
    try {
      validateSchedule(draft.condition.schedule);
    } catch (error) {
      issues.push(
        issue(
          "AUTOMATION_SCHEDULE_INVALID",
          error instanceof Error ? error.message : String(error),
          "time",
          "condition.schedule",
        ),
      );
    }
  }
  if (
    "objectTypeApiName" in draft.condition &&
    !draft.condition.objectTypeApiName.trim()
  ) {
    issues.push(
      issue(
        "OBJECT_TYPE_REQUIRED",
        "Select an object type.",
        "condition",
        "condition.objectTypeApiName",
      ),
    );
  }
  if ("objectSet" in draft.condition) {
    const objectSet = ObjectSet.safeParse(draft.condition.objectSet);
    if (!objectSet.success) {
      issues.push(
        issue(
          "OBJECT_SET_INVALID",
          "Configure a valid canonical Tellus object set.",
          "condition",
          "condition.objectSet",
        ),
      );
    } else if (
      draft.condition.evaluationMode === "live" &&
      (objectSet.data as { type?: string }).type !== "base"
    ) {
      issues.push(
        issue(
          "LIVE_OBJECT_SET_UNSUPPORTED",
          "Live monitoring currently supports canonical base object sets; use scheduled evaluation for composed sets.",
          "condition",
          "condition.objectSet",
        ),
      );
    }
  }
  if (draft.condition.type === "threshold-crossed") {
    validateThresholdExpression(draft.condition.expression, issues);
  }
  if (
    draft.condition.type === "automation-dependency" &&
    !draft.condition.parentAutomationId
  ) {
    issues.push(
      issue(
        "DEPENDENCY_REQUIRED",
        "Select a parent automation.",
        "condition",
        "condition.parentAutomationId",
      ),
    );
  }
  if (draft.effects.length === 0) {
    issues.push(
      issue(
        "AUTOMATION_EFFECT_REQUIRED",
        "At least one effect is required.",
        "effects",
        "effects",
      ),
    );
  }
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const effect of draft.effects) {
    if (ids.has(effect.id)) {
      issues.push(
        issue(
          "AUTOMATION_EFFECT_ID_DUPLICATE",
          "Effect IDs must be unique.",
          "effects",
          "effects",
          effect.id,
        ),
      );
    }
    ids.add(effect.id);
    if (orders.has(effect.order)) {
      issues.push(
        issue(
          "AUTOMATION_EFFECT_ORDER_DUPLICATE",
          "Effect order values must be unique.",
          "effects",
          "effects",
          effect.id,
        ),
      );
    }
    orders.add(effect.order);
    if (effect.type === "logic") {
      issues.push(
        issue(
          "LOGIC_RUNTIME_UNAVAILABLE",
          "Tellus does not currently expose a canonical Logic registry/runtime.",
          "effects",
          "effects",
          effect.id,
        ),
      );
    }
    if (
      effect.type === "function" &&
      (!effect.functionRid ||
        !effect.repositoryRid ||
        !effect.apiName ||
        !effect.branch ||
        !effect.version ||
        !effect.artifactSha256)
    ) {
      issues.push(
        issue(
          "FUNCTION_REQUIRED",
          "Select and pin a published Function version.",
          "effects",
          "effects.functionRid",
          effect.id,
        ),
      );
    }
    if (effect.type === "notification") {
      if (
        effect.channels.length === 0 ||
        effect.recipients.static.length +
          effect.recipients.dynamic.length ===
          0
      ) {
        issues.push(
          issue(
            "NOTIFICATION_RECIPIENT_REQUIRED",
            "Select a notification channel and at least one recipient.",
            "effects",
            "effects.recipients",
            effect.id,
          ),
        );
      }
      if (
        effect.content.kind === "plain" &&
        !effect.content.useSystemFallback &&
        (!effect.content.heading.trim() || !effect.content.message.trim())
      ) {
        issues.push(
          issue(
            "NOTIFICATION_CONTENT_REQUIRED",
            "Notification heading and message are required.",
            "effects",
            "effects.content",
            effect.id,
          ),
        );
      }
      if (
        effect.content.kind === "function" &&
        (!effect.content.functionRid ||
          !effect.content.repositoryRid ||
          !effect.content.apiName ||
          !effect.content.branch ||
          !effect.content.version ||
          !effect.content.artifactSha256)
      ) {
        issues.push(
          issue(
            "FUNCTION_REQUIRED",
            "Select and pin a published notification Function version.",
            "effects",
            "effects.content.functionRid",
            effect.id,
          ),
        );
      }
    }
    for (const binding of collectBindings(effect)) {
      if (
        binding.kind === "object-property" &&
        !["objects-added", "objects-modified", "run-on-all"].includes(
          draft.condition.type,
        )
      ) {
        issues.push(
          issue(
            "BINDING_PATH_INVALID",
            "This condition does not expose a readable trigger object.",
            "effects",
            "effects.parameters",
            effect.id,
          ),
        );
      }
      if (binding.kind === "condition-output") {
        const allowedRoots: Record<string, string[]> = {
          time: ["triggeredAt", "scheduledFor"],
          "objects-added": ["triggeredAt", "objectTypeId", "objectId", "object", "currentValues"],
          "objects-removed": ["triggeredAt", "objectTypeId", "objectId", "removedObject", "previousValues"],
          "objects-modified": ["triggeredAt", "objectTypeId", "objectId", "object", "currentValues", "previousValues", "changedProperties"],
          "run-on-all": ["triggeredAt", "objectTypeId", "objectId", "object", "currentValues"],
          "threshold-crossed": ["triggeredAt", "previousValue", "currentValue", "metricValues", "direction"],
          "automation-dependency": ["triggeredAt", "parentAutomationId", "parentAutomationVersion", "parentTriggerEventId", "parentStatus", "parentOutput"],
          "time-series": [],
          stream: [],
          "metric-changed": [],
        };
        const root = binding.path.split(".")[0] ?? "";
        if (!allowedRoots[draft.condition.type]?.includes(root)) {
          issues.push(
            issue(
              "BINDING_PATH_INVALID",
              `Condition output path '${binding.path}' is not exposed by ${draft.condition.type}.`,
              "effects",
              "effects.parameters",
              effect.id,
            ),
          );
        }
      }
      if (binding.kind !== "effect-output") continue;
      const referenced = draft.effects.find(
        (candidate) => candidate.id === binding.effectId,
      );
      if (!referenced) {
        issues.push(
          issue(
            "BINDING_PATH_INVALID",
            "Effect output binding references an effect that does not exist.",
            "effects",
            "effects.parameters",
            effect.id,
          ),
        );
      } else if (draft.executionStrategy.mode === "parallel") {
        issues.push(
          issue(
            "BINDING_PARALLEL_EFFECT_FORBIDDEN",
            "Parallel effects cannot consume sibling effect outputs.",
            "effects",
            "effects.parameters",
            effect.id,
          ),
        );
      } else if (referenced.order >= effect.order) {
        issues.push(
          issue(
            "BINDING_EFFECT_ORDER_INVALID",
            "An effect may only consume output from an earlier sequential effect.",
            "effects",
            "effects.parameters",
            effect.id,
          ),
        );
      }
    }
  }
  return {
    valid: !issues.some((entry) => entry.severity === "error"),
    issues,
    normalizedDraft: draft,
  };
}

async function validateActionReference(
  db: Queryable,
  draft: AutomationDraft,
  effect: Extract<EffectDraft, { type: "action" }>,
): Promise<ValidationIssue[]> {
  if (
    !effect.actionTypeId ||
    !effect.actionApiName ||
    effect.definitionVersion === null
  ) {
    return [
      issue(
        "ACTION_REQUIRED",
        "Select an Action Type before activation.",
        "effects",
        "effects.actionTypeId",
        effect.id,
      ),
    ];
  }
  const result = await db.query<{
    action_type_id: string;
    api_name: string;
    is_enabled: boolean;
    definition_version: number;
    definition_hash: string | null;
    parameters: Array<{
      apiName?: string;
      required?: boolean;
      type?: string;
    }>;
  }>(
    `SELECT action_type_id, api_name, is_enabled, definition_version,
            definition_hash, parameters
       FROM action_type
      WHERE ontology_id = $1 AND action_type_id = $2`,
    [draft.ontologyId, effect.actionTypeId],
  );
  const row = result.rows[0];
  if (!row) {
    return [
      issue(
        "ACTION_NOT_FOUND",
        "The selected Action Type no longer exists.",
        "effects",
        "effects.actionTypeId",
        effect.id,
      ),
    ];
  }
  const issues: ValidationIssue[] = [];
  if (!row.is_enabled) {
    issues.push(
      issue(
        "ACTION_NOT_EXECUTABLE",
        "The selected Action Type is disabled.",
        "effects",
        "effects.actionTypeId",
        effect.id,
      ),
    );
  }
  if (
    row.api_name !== effect.actionApiName ||
    row.definition_version !== effect.definitionVersion ||
    row.definition_hash !== effect.definitionHash
  ) {
    issues.push(
      issue(
        "ACTION_DEFINITION_CHANGED",
        "The selected Action Type definition changed; review and reselect it.",
        "effects",
        "effects.actionTypeId",
        effect.id,
      ),
    );
  }
  for (const parameter of row.parameters ?? []) {
    const binding = parameter.apiName
      ? effect.parameters[parameter.apiName]
      : undefined;
    if (
      parameter.required !== false &&
      parameter.apiName &&
      (binding === undefined ||
        (binding.kind === "constant" &&
          (binding.value === null || binding.value === "")))
    ) {
      issues.push(
        issue(
          "ACTION_PARAMETER_REQUIRED",
          `Action parameter '${parameter.apiName}' is required.`,
          "effects",
          `effects.parameters.${parameter.apiName}`,
          effect.id,
        ),
      );
    }
    if (
      binding?.kind === "object-property" &&
      "objectTypeApiName" in draft.condition
    ) {
      const property = await db.query<{ base_type: string }>(
        `SELECT property.base_type
           FROM property
           JOIN object_type
             ON object_type.object_type_id = property.object_type_id
          WHERE object_type.ontology_id = $1
            AND object_type.api_name = $2
            AND property.api_name = $3`,
        [
          draft.ontologyId,
          draft.condition.objectTypeApiName,
          binding.propertyId,
        ],
      );
      if (!property.rowCount) {
        issues.push(
          issue(
            "BINDING_PATH_INVALID",
            `Object property '${binding.propertyId}' no longer exists or is inaccessible.`,
            "effects",
            `effects.parameters.${parameter.apiName}`,
            effect.id,
          ),
        );
      } else {
        const numeric = new Set([
          "integer", "long", "short", "byte", "float", "double", "decimal",
        ]);
        const expected = parameter.type ?? "";
        const actual = property.rows[0].base_type;
        if (
          (numeric.has(expected) && !numeric.has(actual)) ||
          (expected === "boolean" && actual !== "boolean")
        ) {
          issues.push(
            issue(
              "BINDING_TYPE_MISMATCH",
              `Property '${binding.propertyId}' (${actual}) is incompatible with '${parameter.apiName}' (${expected}).`,
              "effects",
              `effects.parameters.${parameter.apiName}`,
              effect.id,
            ),
          );
        }
      }
    }
  }
  return issues;
}

type FunctionReference = {
  id: string;
  functionRid: string | null;
  repositoryRid: string | null;
  apiName: string | null;
  branch: string | null;
  version: string | null;
  artifactSha256: string | null;
  parameters: Record<string, ValueBinding>;
};

export function isNotificationFunctionOutputContract(output: unknown): boolean {
  if (typeof output !== "string") return false;
  const compact = output.replace(/\s+/g, "");
  return (
    /(?:^|[<{;,])heading:string(?:[;,}]|$)/.test(compact) &&
    /(?:^|[<{;,])message:string(?:[;,}]|$)/.test(compact) &&
    ((!compact.includes("url:") && !compact.includes("url?:")) ||
      /(?:^|[<{;,])url\??:string(?:[;,}]|$)/.test(compact)) &&
    ((!compact.includes("locale:") && !compact.includes("locale?:")) ||
      /(?:^|[<{;,])locale\??:string(?:[;,}]|$)/.test(compact))
  );
}

async function validateFunctionReference(
  db: Queryable,
  effect: FunctionReference,
  owner?: { userId: string; platformAdmin: boolean },
  location: {
    step: ValidationIssue["step"];
    path: string;
  } = { step: "effects", path: "effects" },
  expectedOutput?: "notification",
): Promise<ValidationIssue[]> {
  if (
    !effect.functionRid ||
    !effect.repositoryRid ||
    !effect.apiName ||
    !effect.branch ||
    !effect.version ||
    !effect.artifactSha256
  ) {
    return [];
  }
  const result = await db.query<{
    repository_rid: string;
    api_name: string;
    artifact_sha256: string;
    state: string;
    runtime: string;
    function_kind: string | null;
    signature: {
      parameters?: Array<{ name?: string; optional?: boolean }>;
      output?: string;
    } | null;
    invocation_contract: string | null;
  }>(
    `SELECT function.repository_rid, function.api_name,
            release.artifact_sha256, release.state, release.runtime,
            version.function_kind, version.signature,
            version.invocation_contract
       FROM function_registry_function function
       JOIN function_registry_function_version version
         ON version.function_rid = function.rid
        AND version.branch = $2 AND version.semver = $3
       JOIN function_version release
         ON release.rid = version.release_version_rid
      WHERE function.rid = $1`,
    [effect.functionRid, effect.branch, effect.version],
  );
  const row = result.rows[0];
  if (!row) {
    return [
      issue(
        "FUNCTION_VERSION_NOT_FOUND",
        "The selected Function version no longer exists.",
        location.step,
        `${location.path}.functionRid`,
        effect.id,
      ),
    ];
  }
  const issues: ValidationIssue[] = [];
  if (
    row.repository_rid !== effect.repositoryRid ||
    row.api_name !== effect.apiName ||
    row.artifact_sha256 !== effect.artifactSha256
  ) {
    issues.push(
      issue(
        "FUNCTION_VERSION_INCOMPATIBLE",
        "The selected Function identity or immutable artifact does not match.",
        location.step,
        `${location.path}.functionRid`,
        effect.id,
      ),
    );
  }
  if (
    expectedOutput === "notification" &&
    !isNotificationFunctionOutputContract(row.signature?.output)
  ) {
    issues.push(
      issue(
        "FUNCTION_OUTPUT_INCOMPATIBLE",
        "Notification Functions must publish an inline output contract containing heading: string, message: string, and optional url/locale strings.",
        location.step,
        `${location.path}.functionRid`,
        effect.id,
      ),
    );
  }
  if (
    row.state !== "AVAILABLE" ||
    row.runtime !== "NODE_20" ||
    row.function_kind !== "query"
  ) {
    issues.push(
      issue(
        "FUNCTION_NOT_EXECUTABLE",
        "Raw Function effects require an available NODE_20 query Function. Use an Action Type for edits.",
        location.step,
        `${location.path}.functionRid`,
        effect.id,
      ),
    );
  }
  if (row.invocation_contract === "typescript-v2-positional-v2") {
    // Canonical typed validation (backend authoritative): constants are
    // validated recursively against the published type model; missing
    // required parameters, null misuse, and type mismatches are
    // structured field errors. Dynamic bindings (condition/derived) are
    // validated at execution time against the resolved value.
    const canonical = readCanonicalSignature(row.signature);
    if (canonical) {
      // Honest support gate: type kinds with NO supported binding surface
      // (ontology object references, object sets, unrecognised declared
      // types) are a fatal rejection at save/activation time — the UI
      // disables the control; hand-submitted configs die here; the
      // executor repeats the check fail-closed for stale drafts.
      for (const parameter of unsupportedConfiguredParameters(
        canonical.parameters,
        new Set(Object.keys(effect.parameters)),
      )) {
        issues.push(
          issue(
            "FUNCTION_PARAMETER_UNSUPPORTED_TYPE",
            `Function parameter '${parameter.name}' has type '${parameter.typeText || parameter.type.kind}', which is not configurable in this release (ontology object references, object sets, and unrecognized declared types are not yet supported). Remove the binding or republish the Function with a supported parameter type.`,
            location.step,
            `${location.path}.parameters.${parameter.name}`,
            effect.id,
          ),
        );
      }
      const knownNames = new Set(canonical.parameters.map((p) => p.name));
      for (const parameter of canonical.parameters) {
        if (parameter.type.kind === "client") continue; // injected
        const binding = effect.parameters[parameter.name];
        if (binding === undefined) {
          if (!parameter.optional && !parameter.hasDefault) {
            issues.push(
              issue(
                "FUNCTION_PARAMETER_REQUIRED",
                `Function parameter '${parameter.name}' is required.`,
                location.step,
                `${location.path}.parameters.${parameter.name}`,
                effect.id,
              ),
            );
          }
          continue;
        }
        if (binding.kind === "constant") {
          for (const problem of validateConstantValue(parameter, binding.value)) {
            issues.push(
              issue(
                problem.code === "FUNCTION_PARAMETER_MISSING"
                  ? "FUNCTION_PARAMETER_REQUIRED"
                  : "FUNCTION_PARAMETER_TYPE",
                problem.message,
                location.step,
                `${location.path}.parameters.${problem.path}`,
                effect.id,
              ),
            );
          }
        }
      }
      // Configured bindings that the published signature does not declare —
      // warn (not fatal): they are ignored at execution.
      for (const name of Object.keys(effect.parameters)) {
        if (!knownNames.has(name)) {
          issues.push(
            issue(
              "FUNCTION_PARAMETER_UNKNOWN",
              `Configured parameter '${name}' is not declared by Function version ${effect.version} and will be ignored.`,
              location.step,
              `${location.path}.parameters.${name}`,
              effect.id,
              "warning",
            ),
          );
        }
      }
    }
  } else {
    // Legacy invocation contract: preserved behavior plus a non-fatal
    // deprecation warning carrying the operator-configured sunset date so
    // activation surfaces and audits both see the migration signal.
    const policy = executionPolicy();
    issues.push(
      issue(
        "FUNCTION_LEGACY_CONTRACT_DEPRECATED",
        `This Function version uses the deprecated legacy-object-envelope-v1 invocation contract.${
          policy.legacyDeprecationDate
            ? ` Scheduled for removal after ${policy.legacyDeprecationDate}.`
            : ""
        } Republish the Function to migrate it onto typescript-v2-positional-v2.`,
        location.step,
        `${location.path}.functionRid`,
        effect.id,
        "warning",
      ),
    );
    for (const parameter of row.signature?.parameters ?? []) {
      if (
        parameter.optional !== true &&
        parameter.name &&
        effect.parameters[parameter.name] === undefined
      ) {
        issues.push(
          issue(
            "FUNCTION_PARAMETER_REQUIRED",
            `Function parameter '${parameter.name}' is required.`,
            location.step,
            `${location.path}.parameters.${parameter.name}`,
            effect.id,
          ),
        );
      }
    }
  }
  if (owner) {
    const access = await db.query<{ allowed: boolean }>(
      `SELECT (
         $3::boolean
         OR repository.created_by::text = $2
         OR EXISTS (
           SELECT 1
             FROM folders folder
             JOIN project_members membership
               ON membership.project_id = folder.project_id
            WHERE folder.id::text =
                  substring(
                    repository.parent_folder_rid FROM '([0-9a-fA-F-]{36})$'
                  )
              AND membership.user_id::text = $2
         )
         OR EXISTS (
           SELECT 1
             FROM projects project
             JOIN project_members membership
               ON membership.project_id = project.id
            WHERE project.id::text =
                  substring(repository.project_rid FROM '([0-9a-fA-F-]{36})$')
              AND membership.user_id::text = $2
         )
       ) AS allowed
         FROM code_repository repository
        WHERE repository.rid = $1
          AND repository.state IN ('ACTIVE','ARCHIVED')`,
      [effect.repositoryRid, owner.userId, owner.platformAdmin],
    );
    if (access.rows[0]?.allowed !== true) {
      issues.push(
        issue(
          "OWNER_PERMISSION_DENIED",
          "The automation owner cannot access the selected Function.",
          location.step,
          `${location.path}.functionRid`,
          effect.id,
        ),
      );
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Object-set property-filter (objectCondition) semantic validation.
//
// The canonical SearchJsonQueryV2 parse (at the draft schema) rejects
// malformed structure, unknown node types, and depth/node-limit overflows.
// This pass validates the SEMANTIC correctness that needs ontology context:
// every leaf `field` must be an accessible property of the condition's
// object type, and the operator must be compatible with the property's
// base type. It emits structured issues with stable field paths so a forged
// API payload (valid structure, bogus field/operator) cannot activate.
// ---------------------------------------------------------------------------

type FilterNode = {
  type?: string;
  field?: string;
  value?: unknown;
  [key: string]: unknown;
};

const NUMERIC_BASE_TYPES = new Set([
  "integer",
  "long",
  "short",
  "byte",
  "float",
  "double",
  "decimal",
]);
const DATE_BASE_TYPES = new Set(["date", "timestamp"]);
const TEXT_OPS = new Set([
  "contains",
  "startsWith",
  "wildcard",
  "regex",
  "containsAllTerms",
  "containsAnyTerm",
  "containsAllTermsInOrder",
  "containsAllTermsInOrderPrefixLastTerm",
]);
const RANGE_OPS = new Set(["gt", "gte", "lt", "lte", "interval"]);

async function validateObjectConditionFields(
  db: Queryable,
  ontologyId: string,
  objectTypeApiName: string,
  rawCondition: unknown,
  path: string,
  issues: ValidationIssue[],
): Promise<void> {
  const properties = await db.query<{ api_name: string; base_type: string }>(
    `SELECT property.api_name, property.base_type
       FROM property
       JOIN object_type
         ON object_type.object_type_id = property.object_type_id
      WHERE object_type.ontology_id = $1
        AND object_type.api_name = $2`,
    [ontologyId, objectTypeApiName],
  );
  const baseTypeByName = new Map(
    properties.rows.map((row) => [row.api_name, row.base_type]),
  );

  const walk = (node: FilterNode, nodePath: string): void => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      return;
    }
    if (node.type === "and" || node.type === "or") {
      const children = Array.isArray(node.value) ? node.value : [];
      if (children.length === 0) {
        issues.push(
          issue(
            "OBJECT_CONDITION_EMPTY_GROUP",
            `Empty ${node.type.toUpperCase()} group.`,
            "condition",
            nodePath,
          ),
        );
      }
      children.forEach((child, index) =>
        walk(child as FilterNode, `${nodePath}.value[${index}]`),
      );
      return;
    }
    if (node.type === "not") {
      walk(node.value as FilterNode, `${nodePath}.value`);
      return;
    }
    // Leaf node — validate field + operator/type compatibility.
    if (typeof node.field !== "string" || node.field.length === 0) {
      return;
    }
    if (!baseTypeByName.has(node.field)) {
      issues.push(
        issue(
          "OBJECT_CONDITION_PROPERTY_UNKNOWN",
          `Object property '${node.field}' does not exist or is inaccessible.`,
          "condition",
          `${nodePath}.field`,
        ),
      );
      return;
    }
    const baseType = baseTypeByName.get(node.field) ?? "";
    const numericOrDate = NUMERIC_BASE_TYPES.has(baseType) || DATE_BASE_TYPES.has(baseType);
    if (RANGE_OPS.has(node.type) && !numericOrDate) {
      issues.push(
        issue(
          "OBJECT_CONDITION_OPERATOR_TYPE_MISMATCH",
          `Operator '${node.type}' is not valid for ${baseType} property '${node.field}'.`,
          "condition",
          nodePath,
        ),
      );
    }
    if (TEXT_OPS.has(node.type) && baseType !== "string") {
      issues.push(
        issue(
          "OBJECT_CONDITION_OPERATOR_TYPE_MISMATCH",
          `Operator '${node.type}' is not valid for ${baseType} property '${node.field}'.`,
          "condition",
          nodePath,
        ),
      );
    }
    if (
      node.type !== "isNull" &&
      (node.value === undefined || node.value === null)
    ) {
      issues.push(
        issue(
          "OBJECT_CONDITION_VALUE_REQUIRED",
          `A comparison value is required for operator '${node.type}' on property '${node.field}'.`,
          "condition",
          `${nodePath}.value`,
        ),
      );
    }
  };
  walk(rawCondition as FilterNode, path);
}

export async function validateAutomationForActivation(
  db: Queryable,
  raw: unknown,
  automationId?: string,
  tenantId?: string,
): Promise<ValidationResult> {
  const base = validateAutomationDraft(raw);
  if (!base.normalizedDraft) return base;
  const issues = [...base.issues];
  const draft = base.normalizedDraft;
  const ownerResult = automationId
    ? await db.query<{
        owner_user_id: string;
        owner_security_snapshot: { roles?: string[] };
      }>(
        `SELECT owner_user_id, owner_security_snapshot
           FROM automation
          WHERE automation_id = $1 AND tenant_id = $2`,
        [automationId, tenantId],
      )
    : null;
  const owner = ownerResult?.rows[0]
    ? {
        userId: ownerResult.rows[0].owner_user_id,
        platformAdmin:
          ownerResult.rows[0].owner_security_snapshot.roles?.some(
            (role) => role.toLowerCase() === "tellus-superadmin",
          ) === true,
      }
    : undefined;

  const ontology = await db.query(
    "SELECT 1 FROM ontology WHERE ontology_id = $1",
    [draft.ontologyId],
  );
  if (!ontology.rowCount) {
    issues.push(
      issue(
        "ONTOLOGY_NOT_FOUND",
        "The selected ontology no longer exists.",
        "condition",
        "ontologyId",
      ),
    );
  }
  // Object-set property filter: validate every leaf's field against the
  // object type's accessible properties and the operator against the
  // property's base type, with stable field paths. A forged payload cannot
  // bypass this because the canonical SearchJsonQueryV2 parse already
  // rejected malformed structure and this checks semantic correctness.
  if (
    "objectCondition" in draft.condition &&
    draft.condition.objectCondition != null &&
    "objectTypeApiName" in draft.condition
  ) {
    await validateObjectConditionFields(
      db,
      draft.ontologyId,
      draft.condition.objectTypeApiName,
      draft.condition.objectCondition,
      "condition.objectCondition",
      issues,
    );
  }
  if (draft.condition.type === "threshold-crossed") {
    const validateThresholdFunctions = async (
      expression: ThresholdExpression,
      path: string,
    ): Promise<void> => {
      if (expression.kind === "group") {
        for (let index = 0; index < expression.children.length; index += 1) {
          await validateThresholdFunctions(
            expression.children[index],
            `${path}.children.${index}`,
          );
        }
        return;
      }
      if (expression.kind === "function") {
        issues.push(
          ...(await validateFunctionReference(db, expression, owner, {
            step: "condition",
            path,
          })),
        );
      }
    };
    await validateThresholdFunctions(
      draft.condition.expression,
      "condition.expression",
    );
  }
  for (const effect of draft.effects) {
    if (effect.type === "notification" && effect.content.kind === "function") {
      const content = effect.content;
      if (
        content.functionRid &&
        content.repositoryRid &&
        content.apiName &&
        content.branch &&
        content.version &&
        content.artifactSha256
      ) {
        issues.push(
          ...(await validateFunctionReference(
            db,
            { id: effect.id, ...content },
            owner,
            { step: "effects", path: "effects.content" },
            "notification",
          )),
        );
      }
    }
    if (effect.type === "action") {
      issues.push(...(await validateActionReference(db, draft, effect)));
    }
    if (effect.type === "function") {
      issues.push(...(await validateFunctionReference(db, effect, owner)));
    }
    const fallback = effect.fallbackEffect;
    if (fallback?.type === "action") {
      issues.push(...(await validateActionReference(db, draft, fallback)));
    } else if (fallback?.type === "function") {
      issues.push(...(await validateFunctionReference(db, fallback, owner)));
    } else if (fallback?.type === "logic") {
      issues.push(
        issue(
          "LOGIC_RUNTIME_UNAVAILABLE",
          "Tellus does not currently expose a canonical Logic registry/runtime.",
          "effects",
          "effects.fallbackEffect",
          effect.id,
        ),
      );
    } else if (
      fallback?.type === "notification" &&
      (fallback.channels.length === 0 ||
        fallback.recipients.static.length +
          fallback.recipients.dynamic.length ===
          0)
    ) {
      issues.push(
        issue(
          "NOTIFICATION_RECIPIENT_REQUIRED",
          "The fallback notification requires a channel and recipient.",
          "effects",
          "effects.fallbackEffect.recipients",
          effect.id,
        ),
      );
    }
  }
  if (draft.condition.type === "automation-dependency") {
    if (draft.condition.parentAutomationId === automationId) {
      issues.push(
        issue(
          "DEPENDENCY_SELF_REFERENCE",
          "An automation cannot depend on itself.",
          "condition",
          "condition.parentAutomationId",
        ),
      );
    }
    const parent = draft.condition.parentAutomationId
      ? await db.query<{ definition: unknown }>(
      `SELECT version.definition
         FROM automation parent
         JOIN automation_version version
           ON version.automation_id = parent.automation_id
          AND version.version = parent.current_version
        WHERE parent.automation_id = $1 AND parent.tenant_id = $2
          AND parent.status <> 'archived'`,
      [draft.condition.parentAutomationId, tenantId],
      )
      : null;
    if (draft.condition.parentAutomationId && !parent?.rowCount) {
      issues.push(
        issue(
          "DEPENDENCY_NOT_FOUND",
          "The selected parent automation is inaccessible or no longer exists.",
          "condition",
          "condition.parentAutomationId",
        ),
      );
    } else if (
      parent?.rows[0] &&
      AutomationDraftSchema.safeParse(parent.rows[0].definition).data
        ?.condition.type === "automation-dependency"
    ) {
      issues.push(
        issue(
          "DEPENDENCY_DEPTH_EXCEEDED",
          "Dependency chains are limited to one level.",
          "condition",
          "condition.parentAutomationId",
        ),
      );
    }
  }

  return {
    valid: !issues.some((entry) => entry.severity === "error"),
    issues,
    normalizedDraft: draft,
  };
}
