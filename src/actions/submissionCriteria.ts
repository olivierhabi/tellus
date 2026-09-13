// ---------------------------------------------------------------------------
// Action submission criteria — FOUNDRY-GAPS §5 (Actions, Stage 3).
//
// Foundry "submission criteria" are conditions that must hold for an action to
// be submittable. They run AFTER parameter validation (Stage 2) and BEFORE rule
// compilation (Stage 4): if any required condition fails, the action is
// rejected with SUBMISSION_CRITERIA_NOT_MET and no edits are produced.
//
// This is a pure, side-effect-free evaluator (no DB, no IO) so it is fully
// unit-testable and cannot wedge the executor. CBAC (allowed/denied principals
// + required markings, migration 037) governs WHO may run an action; submission
// criteria govern WHETHER the supplied inputs / subject satisfy the action's
// preconditions.
//
// Schema (action_type.submission_criteria JSONB; null/absent ⇒ allow all):
//   {
//     "match": "all" | "any",            // default "all"
//     "conditions": [
//       { "parameter": "amount", "operator": "lte", "value": 1000 },
//       { "parameter": "status", "operator": "in", "value": ["draft","pending"] },
//       { "parameter": "reason", "operator": "exists" },
//       { "role": "approver" },           // subject must hold this role
//       { "anyRole": ["approver","admin"] },
//       { "group": "finance" },           // subject must be in this group
//       { "organization": "bihire" },     // subject's multipass org
//       { "executionContext": "scenario" },
//       // Nested logical group (arbitrary depth):
//       { "operator": "any", "conditions": [ ...nodes... ] },
//       { "operator": "none", "conditions": [ ...nodes... ] }
//     ]
//   }
// A bare string condition ("statusIsDraft") is treated as an always-pass label.
//
// NESTED GROUPS. A condition node is either a LEAF (the predicate shapes above)
// or a GROUP — `{ operator: "all"|"any"|"none", conditions: [...] }` — which
// combines child nodes recursively. `none` passes iff NO child passes. Groups
// nest to arbitrary depth; an empty group passes (vacuous, matching the
// top-level empty-criteria allow-all rule). This is what the Ontology Manager
// "Security & Submission Criteria" editor authors via its "logical operator"
// rows, so the evaluator MUST understand them: an unrecognised condition object
// falls through to always-pass (forward compatibility), which would silently
// disable every criterion nested inside a group the evaluator can't read.
// ---------------------------------------------------------------------------

export type SubmissionOperator =
  | "eq" | "ne" | "lt" | "lte" | "gt" | "gte"
  | "in" | "nin" | "exists" | "absent" | "truthy" | "falsy"
  // Regex match against the stringified operand ("matches" in the OM editor).
  | "matches"
  // Multi-value (array operand) predicates surfaced by the OM editor as
  // "includes" / "includes any" / "each is" / "each is not". `in`/`nin` remain
  // the scalar-in-list form ("is included in").
  | "contains" | "containsAny" | "eachIs" | "eachIsNot";

/** Logical combinator for a nested condition group. */
export type SubmissionGroupOperator = "all" | "any" | "none";

export interface SubmissionSubject {
  username?: string | null;
  /** Immutable platform subject id (for example the Multipass/Keycloak user id). */
  userId?: string | null;
  roles?: string[];
  groups?: string[];
  /** Multipass organizations the subject belongs to (securityContext.organizations). */
  organizations?: string[];
  /**
   * The execution context the action is being submitted under. Foundry
   * distinguishes a normal ("live") submission from one made inside a
   * scenario / what-if sandbox; `{ executionContext: "scenario" }` conditions
   * gate on it. Absent ⇒ treated as "live".
   */
  executionContext?: string | null;
}

export interface SubmissionEvaluation {
  ok: boolean;
  failures: string[];
}

const NUMERIC_OPS = new Set<SubmissionOperator>(["lt", "lte", "gt", "gte"]);

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

/**
 * Evaluate a B18/B19/C21 predicate `{ parameter, operator, value }` against a
 * map of resolved parameter values (sync, IO-free). Shared by the conditional
 * overrides (parameterValidator Step 5c) and is consistent with the FE
 * `lib/predicate.ts` model + the submission-criteria `compare`.
 */
export function evalParamPredicate(
  predicate: { parameter?: string; operator?: SubmissionOperator; value?: unknown },
  params: Record<string, unknown>,
): boolean {
  if (!predicate || typeof predicate !== "object" || !predicate.parameter) return true;
  return compare(
    params[predicate.parameter],
    (predicate.operator ?? "exists") as SubmissionOperator,
    predicate.value,
  );
}

function compare(actual: unknown, op: SubmissionOperator, expected: unknown): boolean {
  switch (op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "absent":
      return actual === undefined || actual === null;
    case "truthy":
      return Boolean(actual);
    case "falsy":
      return !actual;
    case "eq":
      return actual === expected || String(actual) === String(expected);
    case "ne":
      return !(actual === expected || String(actual) === String(expected));
    case "in":
      return asArray(expected).some((e) => e === actual || String(e) === String(actual));
    case "nin":
      return !asArray(expected).some((e) => e === actual || String(e) === String(actual));
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const a = Number(actual);
      const b = Number(expected);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return op === "lt" ? a < b : op === "lte" ? a <= b : op === "gt" ? a > b : a >= b;
    }
    // Regex match ("matches" in the OM editor). An invalid pattern fails
    // closed rather than throwing out of the evaluator.
    case "matches": {
      if (actual == null || expected == null) return false;
      try {
        return new RegExp(String(expected)).test(String(actual));
      } catch {
        return false;
      }
    }
    // Multi-value predicates: the LHS is the array operand.
    case "contains":
      return asArray(actual).some((a) => a === expected || String(a) === String(expected));
    case "containsAny": {
      const lhs = asArray(actual);
      return asArray(expected).some((e) =>
        lhs.some((a) => a === e || String(a) === String(e)),
      );
    }
    case "eachIs": {
      const lhs = asArray(actual);
      // Vacuous truth on an empty operand matches `Array.every` semantics and
      // the "no values to violate the rule" reading.
      return lhs.every((a) => a === expected || String(a) === String(expected));
    }
    case "eachIsNot":
      return asArray(actual).every((a) => !(a === expected || String(a) === String(expected)));
    default:
      return false;
  }
}

interface Condition {
  parameter?: string;
  operator?: SubmissionOperator | SubmissionGroupOperator;
  value?: unknown;
  role?: string;
  anyRole?: string[];
  group?: string;
  anyGroup?: string[];
  username?: string;
  anyUsername?: string[];
  /**
   * Foundry-style Current User comparison against another operand. This is
   * intentionally separate from the legacy `{ username: "..." }` static
   * allow-list shape above. Example maker/checker guard:
   *
   *   { currentUser: "username", parameter: "approvalId",
   *     objectType: "Approval", objectProperty: "requestedByPrincipal",
   *     operator: "ne" }
   *
   * The object-property operand is resolved from live object state at submit
   * time (and again inside the mutation transaction by the executor).
   */
  currentUser?: "id" | "username";
  /** Subject's multipass organization must include this org. */
  organization?: string;
  /** Subject must belong to at least one of these organizations. */
  anyOrganization?: string[];
  /**
   * Gate on the submission's execution context (e.g. "scenario" vs "live").
   * Compared case-insensitively against `subject.executionContext`; an absent
   * subject context is treated as "live".
   */
  executionContext?: string;
  /**
   * Nested logical group — present iff this node is a GROUP rather than a
   * leaf predicate. `operator` then carries the combinator ("all"|"any"|
   * "none") and `conditions` the child nodes, evaluated recursively.
   */
  conditions?: Condition[];
  description?: string;
  /**
   * D27 — when set alongside `parameter`, the operand is a PROPERTY of the
   * object referenced by the (object_reference) `parameter`. The executor
   * pre-resolves referenced-object properties into `objectPropertyValues`
   * (keyed `${parameter}.${objectProperty}`) BEFORE calling
   * `evaluateSubmissionCriteria`, keeping this evaluator pure/IO-free. The
   * comparison then runs against the live object state at submit time.
   */
  objectProperty?: string;
  /**
   * B1 (cross-functionality engagement) — stale-form / "previousStatus"
   * detection. When set alongside `{ parameter, objectProperty }`, the RHS of
   * the comparison is the value of THIS other parameter (typically a hidden
   * client-side param populated from the same object property at form-open
   * time via `defaultFromObjectReference`), instead of the static `value`.
   * The LHS (`parameter.objectProperty`) is re-resolved from the LIVE object
   * at submit time by `resolveObjectPropertyOperands`. So:
   *   { parameter:"<pkParam>", objectProperty:"status",
   *     operator:"eq", compareParameter:"_previousStatus",
   *     objectType:"OlivierOrderJune" }
   * passes iff the target object's CURRENT status equals the cached client
   * value — stale-form rejection is the LHS ≠ RHS case. Additive + opt-in:
   * when `compareParameter` is absent the existing D27 (object-property vs
   * static `value`) behaviour is unchanged.
   */
  compareParameter?: string;
  /**
   * B1 — the object type to fetch the live object from, when the condition's
   * `parameter` is a STRING primary-key parameter (NOT an object_reference
   * with its own `objectType`). When present, `resolveObjectPropertyOperands`
   * uses this `objectType` + the parameter's value as the PK to fetch the live
   * object (falling back to the paramDef's `objectType` for D27
   * object_reference parameters). Lets a `{parameter:"orderId",
   * objectType:"OlivierOrderJune"}` condition resolve without an
   * object_reference param.
   */
  objectType?: string;
}

const GROUP_OPERATORS = new Set<string>(["all", "any", "none"]);

/**
 * A node is a GROUP iff it carries a `conditions` array. `operator` then names
 * the combinator; anything unrecognised degrades to "all" (the safest reading:
 * every child must hold).
 */
function isGroupNode(cond: Condition): boolean {
  return Array.isArray(cond.conditions);
}

function groupOperatorOf(cond: Condition): SubmissionGroupOperator {
  const op = typeof cond.operator === "string" ? cond.operator : "all";
  return (GROUP_OPERATORS.has(op) ? op : "all") as SubmissionGroupOperator;
}

/**
 * Evaluate a nested condition GROUP. Recurses through `evalNode`, so groups
 * nest to arbitrary depth.
 *
 * - `all`  — every child must pass (empty ⇒ pass, vacuous).
 * - `any`  — at least one child must pass (empty ⇒ pass, matching the
 *            top-level "no conditions ⇒ allow all" rule rather than
 *            fail-closing an unfinished group).
 * - `none` — no child may pass (empty ⇒ pass).
 *
 * The group's own `description` is the author-configured failure message
 * (root-level groups carry the failure message shown across consuming apps);
 * when absent the child reasons are joined so the caller still learns why.
 */
function evalGroup(
  cond: Condition,
  parameters: Record<string, unknown>,
  subject: SubmissionSubject,
  objectPropertyValues: Record<string, unknown> | undefined,
  depth: number,
): { ok: boolean; reason: string } {
  const custom = typeof cond.description === "string" && cond.description.trim()
    ? cond.description
    : null;
  const op = groupOperatorOf(cond);
  const children = (cond.conditions ?? []).filter(
    (c) => c != null && (typeof c === "object" || typeof c === "string"),
  );
  if (children.length === 0) return { ok: true, reason: "" };

  const results = children.map((child) =>
    evalNode(child, parameters, subject, objectPropertyValues, depth + 1),
  );
  const ok =
    op === "any"
      ? results.some((r) => r.ok)
      : op === "none"
        ? !results.some((r) => r.ok)
        : results.every((r) => r.ok);
  if (ok) return { ok: true, reason: "" };

  const childReasons = results
    .filter((r) => !r.ok)
    .map((r) => r.reason)
    .filter(Boolean);
  const synthesized =
    op === "none"
      ? `none of ${children.length} nested conditions may be satisfied`
      : op === "any"
        ? `none of ${children.length} nested 'any' conditions were satisfied${
            childReasons.length ? `: ${childReasons.join("; ")}` : ""
          }`
        : childReasons.join("; ") || `nested 'all' group not satisfied`;
  return { ok: false, reason: custom ?? synthesized };
}

/**
 * Evaluate one condition node — dispatching a GROUP to `evalGroup` (recursive)
 * and a leaf to `evalCondition`. `depth` bounds pathological nesting from a
 * malformed/hostile blob so the evaluator can never blow the stack; a node
 * deeper than the cap fails closed rather than being silently skipped.
 */
const MAX_GROUP_DEPTH = 32;

function evalNode(
  cond: Condition | string,
  parameters: Record<string, unknown>,
  subject: SubmissionSubject,
  objectPropertyValues?: Record<string, unknown>,
  depth = 0,
): { ok: boolean; reason: string } {
  // A bare string is an always-pass label (documented, backward compatible).
  if (typeof cond === "string") return { ok: true, reason: "" };
  if (cond == null || typeof cond !== "object") return { ok: true, reason: "" };
  if (depth > MAX_GROUP_DEPTH) {
    return {
      ok: false,
      reason: `submission criteria nested deeper than ${MAX_GROUP_DEPTH} levels`,
    };
  }
  return isGroupNode(cond)
    ? evalGroup(cond, parameters, subject, objectPropertyValues, depth)
    : evalCondition(cond, parameters, subject, objectPropertyValues);
}

function evalCondition(
  cond: Condition,
  parameters: Record<string, unknown>,
  subject: SubmissionSubject,
  objectPropertyValues?: Record<string, unknown>,
): { ok: boolean; reason: string } {
  // fix(D25): honor the author-configured custom failure message
  // (`description`) when present — it must reach the caller so Workshop can
  // show the configured message instead of the synthesized reason.
  const custom = typeof cond.description === "string" && cond.description.trim()
    ? cond.description
    : null;

  // Current User compared with a parameter/object-property operand. Palantir
  // submission criteria allow the current user's ID to participate in the
  // same logical statement as parameter-derived values; this shape gives the
  // runtime that capability without trusting a client-supplied "checker".
  if (cond.currentUser) {
    const op = (cond.operator ?? "eq") as SubmissionOperator;
    const actual = cond.currentUser === "id" ? subject.userId : subject.username;
    let expected: unknown;
    let operandLabel = "configured value";
    if (cond.parameter && cond.objectProperty) {
      const key = `${cond.parameter}.${cond.objectProperty}`;
      expected = objectPropertyValues?.[key];
      operandLabel = `object property '${key}'`;
      if (expected === undefined) {
        return {
          ok: false,
          reason: custom ?? `${operandLabel} could not be resolved`,
        };
      }
    } else if (cond.compareParameter) {
      expected = parameters[cond.compareParameter];
      operandLabel = `parameter '${cond.compareParameter}'`;
    } else {
      expected = cond.value;
    }
    if (actual == null || actual === "") {
      return {
        ok: false,
        reason: custom ?? `current user ${cond.currentUser} could not be resolved`,
      };
    }
    const ok = compare(actual, op, expected);
    return {
      ok,
      reason: ok
        ? ""
        : (custom ?? `current user ${cond.currentUser} ${op} ${operandLabel} not satisfied`),
    };
  }

  // Parameter predicate (incl. D27 object-property operand).
  if (cond.parameter) {
    const op = (cond.operator ?? "exists") as SubmissionOperator;
    // D27: when objectProperty is set, the operand is the referenced
    // object's property (pre-resolved by the executor). Absent pre-resolved
    // value ⇒ the referenced object/property could not be loaded ⇒ the
    // condition does not hold (fail-closed: never silently pass a property
    // predicate whose operand is unknown).
    let actual: unknown;
    if (cond.objectProperty) {
      const key = `${cond.parameter}.${cond.objectProperty}`;
      actual = objectPropertyValues?.[key];
      if (actual === undefined && op !== "absent") {
        return {
          ok: false,
          reason: custom ?? `referenced object property '${key}' could not be resolved (was ${JSON.stringify(parameters[cond.parameter])})`,
        };
      }
    } else {
      actual = parameters[cond.parameter];
    }
    // B1: when compareParameter is set, the RHS is the value of another
    // parameter (the cached client-side _previousStatus), not the static
    // `value`. resolveObjectPropertyOperands already pre-resolved the LHS
    // (the live object's property) into objectPropertyValues.
    const expected = cond.compareParameter
      ? parameters[cond.compareParameter]
      : cond.value;
    const ok = compare(actual, op, expected);
    const operandLabel = cond.objectProperty
      ? `${cond.parameter}.${cond.objectProperty}`
      : cond.parameter;
    const rhsLabel = cond.compareParameter
      ? ` (vs cached parameter '${cond.compareParameter}'=${JSON.stringify(expected)})`
      : (NUMERIC_OPS.has((cond.operator ?? "exists") as SubmissionOperator) || ["eq","ne","in","nin"].includes((cond.operator ?? "exists") as string)
          ? ` (vs ${JSON.stringify(cond.value)})`
          : "");
    return {
      ok,
      reason: ok ? "" : (custom ?? `${cond.objectProperty ? "object property" : "parameter"} '${operandLabel}' ${op}${
        cond.compareParameter
          ? rhsLabel
          : (NUMERIC_OPS.has(op) || op === "eq" || op === "ne" || op === "in" || op === "nin"
              ? ` ${JSON.stringify(cond.value)}`
              : "")
      } not satisfied (was ${JSON.stringify(actual)})`),
    };
  }
  // Subject role / group predicates.
  const roles = subject.roles ?? [];
  const groups = subject.groups ?? [];
  if (cond.username) {
    const ok = subject.username === cond.username;
    return { ok, reason: ok ? "" : (custom ?? `subject is not required user '${cond.username}'`) };
  }
  if (cond.anyUsername && cond.anyUsername.length) {
    const ok = subject.username != null && cond.anyUsername.includes(subject.username);
    return { ok, reason: ok ? "" : (custom ?? `subject is not one of required users ${JSON.stringify(cond.anyUsername)}`) };
  }
  if (cond.role) {
    const ok = roles.includes(cond.role);
    return { ok, reason: ok ? "" : (custom ?? `subject lacks required role '${cond.role}'`) };
  }
  if (cond.anyRole && cond.anyRole.length) {
    const ok = cond.anyRole.some((r) => roles.includes(r));
    return { ok, reason: ok ? "" : (custom ?? `subject lacks any of roles ${JSON.stringify(cond.anyRole)}`) };
  }
  if (cond.group) {
    const ok = groups.includes(cond.group);
    return { ok, reason: ok ? "" : (custom ?? `subject not in required group '${cond.group}'`) };
  }
  if (cond.anyGroup && cond.anyGroup.length) {
    const ok = cond.anyGroup.some((g) => groups.includes(g));
    return { ok, reason: ok ? "" : (custom ?? `subject not in any of groups ${JSON.stringify(cond.anyGroup)}`) };
  }
  // Multipass organization predicates ("Current User · Organizations ·
  // Includes any of · <org>" in the OM editor).
  const organizations = subject.organizations ?? [];
  if (cond.organization) {
    const ok = organizations.includes(cond.organization);
    return { ok, reason: ok ? "" : (custom ?? `subject not in required organization '${cond.organization}'`) };
  }
  if (cond.anyOrganization && cond.anyOrganization.length) {
    const ok = cond.anyOrganization.some((o) => organizations.includes(o));
    return { ok, reason: ok ? "" : (custom ?? `subject not in any of organizations ${JSON.stringify(cond.anyOrganization)}`) };
  }
  // Execution-context predicate ("Execution context · is · Scenario").
  // An absent subject context means a normal submission ⇒ "live".
  if (cond.executionContext) {
    const actualCtx = (subject.executionContext ?? "live").toLowerCase();
    const ok = actualCtx === cond.executionContext.toLowerCase();
    return {
      ok,
      reason: ok ? "" : (custom ?? `execution context is not '${cond.executionContext}' (was '${actualCtx}')`),
    };
  }
  // Unknown/label condition → pass (forward-compatible).
  return { ok: true, reason: "" };
}

/**
 * Evaluate an action's submission criteria. Returns {ok:true} when criteria is
 * null/absent/empty (allow-all) or all/any conditions are satisfied.
 */
export function evaluateSubmissionCriteria(
  criteria: unknown,
  parameters: Record<string, unknown>,
  subject: SubmissionSubject = {},
  objectPropertyValues?: Record<string, unknown>,
): SubmissionEvaluation {
  if (criteria == null) return { ok: true, failures: [] };

  // Accept either the documented object form or a bare conditions array.
  let match: "all" | "any" = "all";
  let conditions: Condition[];
  if (Array.isArray(criteria)) {
    conditions = criteria as Condition[];
  } else if (typeof criteria === "object") {
    const c = criteria as { match?: string; conditions?: unknown };
    match = c.match === "any" ? "any" : "all";
    conditions = Array.isArray(c.conditions) ? (c.conditions as Condition[]) : [];
  } else {
    // Scalar truthy/falsy gate (rare) — truthy allows.
    return { ok: Boolean(criteria), failures: criteria ? [] : ["submission criteria is false"] };
  }

  if (conditions.length === 0) return { ok: true, failures: [] };

  // evalNode dispatches leaf-vs-group, so a root-level `{operator:"any",
  // conditions:[...]}` node recurses instead of falling through the
  // unknown-condition always-pass branch.
  const results = conditions.map((cond) =>
    evalNode(cond, parameters, subject, objectPropertyValues, 0),
  );
  const failures = results.filter((r) => !r.ok).map((r) => r.reason);

  const ok = match === "any"
    ? results.some((r) => r.ok)
    : results.every((r) => r.ok);

  return {
    ok,
    failures: ok ? [] : (match === "any"
      // fix(D25): keep the per-condition (custom) failure messages for
      // match:"any" instead of discarding them behind a generic line.
      ? [...failures, `none of ${conditions.length} 'any' submission conditions were satisfied`]
      : failures),
  };
}

/**
 * Flatten a criteria blob (array or `{conditions:[]}`) into its LEAF
 * conditions, descending through nested logical groups.
 *
 * Callers use this to find the conditions needing IO pre-resolution (D27
 * object-property operands) and to introspect a criteria blob. Since a group
 * node is itself `{operator, conditions:[...]}`, a non-recursive flatten would
 * return the group instead of the leaves inside it — and every object-property
 * condition nested in a group would go unresolved, then fail closed at
 * evaluation time. Groups are therefore expanded and only leaves returned.
 */
export function extractConditions(criteria: unknown): Condition[] {
  const top = topLevelConditions(criteria);
  const out: Condition[] = [];
  const walk = (nodes: Condition[], depth: number) => {
    if (depth > MAX_GROUP_DEPTH) return;
    for (const node of nodes) {
      if (node == null || typeof node !== "object") continue;
      if (Array.isArray(node.conditions)) walk(node.conditions, depth + 1);
      else out.push(node);
    }
  };
  walk(top, 0);
  return out;
}

/** The criteria blob's own condition array, without descending into groups. */
function topLevelConditions(criteria: unknown): Condition[] {
  if (criteria == null) return [];
  if (Array.isArray(criteria)) return criteria as Condition[];
  if (typeof criteria === "object") {
    const c = criteria as { conditions?: unknown };
    return Array.isArray(c.conditions) ? (c.conditions as Condition[]) : [];
  }
  return [];
}

/**
 * D27 — pre-resolve object-property submission operands.
 *
 * For every condition `{ parameter, objectProperty }`, fetch the object
 * referenced by the (object_reference) `parameter` (using `parameterDefinitions`
 * to resolve the param's `objectType`) and read its `objectProperty`. Returns
 * a map keyed `${parameter}.${objectProperty}` → value, threaded into
 * `evaluateSubmissionCriteria` so the pure evaluator can compare against the
 * live object state at submit time without doing IO.
 *
 * Fail-soft: an unresolvable operand (no objectType, missing PK, object not
 * found) is simply omitted; `evalCondition` then fail-closes that condition
 * (never silently passes a property predicate whose operand is unknown).
 */
export async function resolveObjectPropertyOperands(
  criteria: unknown,
  parameters: Record<string, unknown>,
  parameterDefinitions: ReadonlyArray<{ apiName: string; objectType?: string }>,
  fetcher: (objectType: string, primaryKey: string) => Promise<Record<string, unknown> | null>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const conds = extractConditions(criteria);
  if (conds.length === 0) return out;
  const defMap = new Map<string, { apiName: string; objectType?: string }>();
  for (const def of parameterDefinitions) defMap.set(def.apiName, def);
  for (const cond of conds) {
    if (!cond || typeof cond !== "object") continue;
    const c = cond as Condition;
    if (!c.parameter || !c.objectProperty) continue;
    const def = defMap.get(c.parameter);
    // B1: a condition may carry its own `objectType` so a STRING primary-key
    // parameter (no paramDef.objectType) can still resolve a live object
    // property. Fall back to the paramDef's `objectType` for D27
    // object_reference parameters.
    const objectType = c.objectType ?? def?.objectType;
    const pk = parameters[c.parameter];
    if (!objectType || pk == null || pk === "") continue;
    try {
      const obj = await fetcher(objectType, String(pk));
      if (obj == null) continue;
      // The persisted object document can be keyed by apiName (camelCase) OR
      // by the backing DB column (snake_case — legacy/seed objects). Try
      // apiName first, then snake_case, so the operand resolves regardless.
      const apiName = c.objectProperty;
      let value = obj[apiName];
      if (value === undefined) {
        const snake = apiName.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
        if (snake !== apiName) value = obj[snake];
      }
      out[`${c.parameter}.${c.objectProperty}`] = value;
    } catch {
      // Fail-soft: leave the operand unresolved; the evaluator fail-closes.
      continue;
    }
  }
  return out;
}
