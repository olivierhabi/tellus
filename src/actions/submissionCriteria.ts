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
//       { "group": "finance" }            // subject must be in this group
//     ]
//   }
// A bare string condition ("statusIsDraft") is treated as an always-pass label.
// ---------------------------------------------------------------------------

export type SubmissionOperator =
  | "eq" | "ne" | "lt" | "lte" | "gt" | "gte"
  | "in" | "nin" | "exists" | "absent" | "truthy" | "falsy";

export interface SubmissionSubject {
  username?: string | null;
  roles?: string[];
  groups?: string[];
}

export interface SubmissionEvaluation {
  ok: boolean;
  failures: string[];
}

const NUMERIC_OPS = new Set<SubmissionOperator>(["lt", "lte", "gt", "gte"]);

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
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
    default:
      return false;
  }
}

interface Condition {
  parameter?: string;
  operator?: SubmissionOperator;
  value?: unknown;
  role?: string;
  anyRole?: string[];
  group?: string;
  anyGroup?: string[];
  username?: string;
  anyUsername?: string[];
  description?: string;
}

function evalCondition(
  cond: Condition,
  parameters: Record<string, unknown>,
  subject: SubmissionSubject,
): { ok: boolean; reason: string } {
  // Parameter predicate.
  if (cond.parameter) {
    const op = (cond.operator ?? "exists") as SubmissionOperator;
    const actual = parameters[cond.parameter];
    const ok = compare(actual, op, cond.value);
    return {
      ok,
      reason: ok ? "" : `parameter '${cond.parameter}' ${op}${
        NUMERIC_OPS.has(op) || op === "eq" || op === "ne" || op === "in" || op === "nin"
          ? ` ${JSON.stringify(cond.value)}`
          : ""
      } not satisfied (was ${JSON.stringify(actual)})`,
    };
  }
  // Subject role / group predicates.
  const roles = subject.roles ?? [];
  const groups = subject.groups ?? [];
  if (cond.username) {
    const ok = subject.username === cond.username;
    return { ok, reason: ok ? "" : `subject is not required user '${cond.username}'` };
  }
  if (cond.anyUsername && cond.anyUsername.length) {
    const ok = subject.username != null && cond.anyUsername.includes(subject.username);
    return { ok, reason: ok ? "" : `subject is not one of required users ${JSON.stringify(cond.anyUsername)}` };
  }
  if (cond.role) {
    const ok = roles.includes(cond.role);
    return { ok, reason: ok ? "" : `subject lacks required role '${cond.role}'` };
  }
  if (cond.anyRole && cond.anyRole.length) {
    const ok = cond.anyRole.some((r) => roles.includes(r));
    return { ok, reason: ok ? "" : `subject lacks any of roles ${JSON.stringify(cond.anyRole)}` };
  }
  if (cond.group) {
    const ok = groups.includes(cond.group);
    return { ok, reason: ok ? "" : `subject not in required group '${cond.group}'` };
  }
  if (cond.anyGroup && cond.anyGroup.length) {
    const ok = cond.anyGroup.some((g) => groups.includes(g));
    return { ok, reason: ok ? "" : `subject not in any of groups ${JSON.stringify(cond.anyGroup)}` };
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

  const results = conditions.map((cond) =>
    typeof cond === "string"
      ? { ok: true, reason: "" }
      : evalCondition(cond, parameters, subject),
  );
  const failures = results.filter((r) => !r.ok).map((r) => r.reason);

  const ok = match === "any"
    ? results.some((r) => r.ok)
    : results.every((r) => r.ok);

  return {
    ok,
    failures: ok ? [] : (match === "any"
      ? [`none of ${conditions.length} 'any' submission conditions were satisfied`]
      : failures),
  };
}
