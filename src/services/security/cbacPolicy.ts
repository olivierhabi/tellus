// ---------------------------------------------------------------------------
// src/services/security/cbacPolicy.ts
//
// Closes the runtime half of F-P3-18 (CBAC absent on /actions, /search,
// /audit, /branches) and the markings half of F-P3-19.
//
// Pure policy evaluator — no I/O. The route handler:
//   1. Constructs a Subject from req.security (or req.auth).
//   2. Constructs a Policy from the resource (action_type row, branch row, etc).
//   3. Calls evaluate(subject, policy, context).
//   4. On result.decision === "deny", returns 403 with the reason.
//   5. On allow, proceeds — and ALWAYS appends a row to cbac_decision_log
//      (regardless of decision) via logCbacDecision().
//
// Default-deny: missing policy → DENY. There is no "no policy means
// open" path. This is the F-P3-18 contract: every data-plane route
// either has a Policy or fails closed.
// ---------------------------------------------------------------------------

import { incCounter } from "../funnel/metrics";

export type SubjectKind = "user" | "service" | "token" | "anonymous";

export interface Subject {
  kind: SubjectKind;
  /** Stable identifier — username / service-account / token-id / "anonymous" */
  identifier: string;
  /** Roles assigned to the subject. Empty when none. */
  roles: string[];
  /** Groups assigned. Empty when none. */
  groups: string[];
  /** Markings the subject is cleared for. Empty when none. */
  markings: string[];
}

export type PrincipalSelector =
  | { type: "user"; username: string }
  | { type: "role"; role: string }
  | { type: "group"; group: string }
  | { type: "any" }
  | { type: "any_authenticated" };

export interface Policy {
  /** When non-null, only matching subjects pass the allowlist gate. */
  allowedPrincipals: PrincipalSelector[] | null;
  /** Always applied. Match → DENY. */
  deniedPrincipals: PrincipalSelector[] | null;
  /** Subject must hold every marking in this set. */
  requiredMarkings: string[];
}

export interface PolicyContext {
  resourceKind: string;        // 'action_type' | 'branch' | 'search' | 'audit_query'
  resourceId: string;          // action_type api_name, branch_id, etc.
  ontologyId?: string | null;
  sourceIp?: string | null;
  requestId?: string | null;
}

export type DecisionReason =
  | "anonymous_denied"
  | "denylist_match"
  | "no_allowlist_match"
  | "markings_insufficient"
  | "missing_policy_default_deny"
  | "allow";

export interface Decision {
  decision: "allow" | "deny";
  reason: DecisionReason;
  matchedRule: PrincipalSelector | { kind: "markings"; required: string[]; missing: string[] } | null;
}

function selectorMatches(selector: PrincipalSelector, subject: Subject): boolean {
  switch (selector.type) {
    case "any":
      return true;
    case "any_authenticated":
      return subject.kind !== "anonymous";
    case "user":
      return subject.kind !== "anonymous" && subject.identifier === selector.username;
    case "role":
      return subject.roles.includes(selector.role);
    case "group":
      return subject.groups.includes(selector.group);
    default: {
      // Exhaustiveness — at compile time `selector` should be `never`. At
      // runtime an unknown selector type fails closed (no match).
      return false;
    }
  }
}

function findMatchingSelector(
  selectors: PrincipalSelector[],
  subject: Subject,
): PrincipalSelector | null {
  for (const sel of selectors) {
    if (selectorMatches(sel, subject)) return sel;
  }
  return null;
}

function missingMarkings(required: string[], held: string[]): string[] {
  if (required.length === 0) return [];
  const heldSet = new Set(held);
  return required.filter((m) => !heldSet.has(m));
}

/**
 * Pure CBAC evaluator. Never throws on input shape (caller guarantees
 * Subject + Policy are well-typed). Caller is responsible for emitting
 * the cbac_decision_log row.
 */
export function evaluate(
  subject: Subject,
  policy: Policy | null,
  _context: PolicyContext,
): Decision {
  // Default-deny when policy is missing entirely. There is no implicit-open path.
  if (policy === null) {
    return {
      decision: "deny",
      reason: "missing_policy_default_deny",
      matchedRule: null,
    };
  }

  // Step 1 — denylist beats everything (denylist match → DENY).
  if (policy.deniedPrincipals && policy.deniedPrincipals.length > 0) {
    const denied = findMatchingSelector(policy.deniedPrincipals, subject);
    if (denied) {
      return { decision: "deny", reason: "denylist_match", matchedRule: denied };
    }
  }

  // Step 2 — anonymous subjects denied unless allowlist contains {type:"any"}.
  // (any_authenticated does NOT match anonymous; that is the design.)
  if (subject.kind === "anonymous") {
    const explicitAny = policy.allowedPrincipals?.find((s) => s.type === "any");
    if (!explicitAny) {
      return { decision: "deny", reason: "anonymous_denied", matchedRule: null };
    }
  }

  // Step 3 — allowlist gate.
  if (policy.allowedPrincipals !== null) {
    const matched = findMatchingSelector(policy.allowedPrincipals, subject);
    if (!matched) {
      return { decision: "deny", reason: "no_allowlist_match", matchedRule: null };
    }
  }

  // Step 4 — markings cover.
  const missing = missingMarkings(policy.requiredMarkings, subject.markings);
  if (missing.length > 0) {
    return {
      decision: "deny",
      reason: "markings_insufficient",
      matchedRule: { kind: "markings", required: policy.requiredMarkings, missing },
    };
  }

  return { decision: "allow", reason: "allow", matchedRule: null };
}

/**
 * Construct a Subject from an Express req.security or req.auth shape.
 * Defensive — accepts undefined and yields a frozen anonymous Subject.
 */
export function subjectFromRequest(req: {
  security?: unknown;
  auth?: unknown;
  user?: unknown;
}): Subject {
  const sec = req.security as Record<string, unknown> | undefined;
  const auth = req.auth as Record<string, unknown> | undefined;
  const u = req.user as Record<string, unknown> | undefined;

  const identifier =
    (sec?.subject as string | undefined) ||
    (auth?.preferred_username as string | undefined) ||
    (auth?.sub as string | undefined) ||
    (u?.email as string | undefined) ||
    (u?.id as string | undefined) ||
    "anonymous";

  if (identifier === "anonymous") {
    return { kind: "anonymous", identifier: "anonymous", roles: [], groups: [], markings: [] };
  }

  const roles = ((sec?.roles as string[] | undefined) ||
    (auth?.realm_access as { roles?: string[] } | undefined)?.roles ||
    []) as string[];
  const groups = ((sec?.groups as string[] | undefined) ||
    (auth?.groups as string[] | undefined) ||
    []) as string[];
  const markings = ((sec?.markings as string[] | undefined) ||
    (auth?.markings as string[] | undefined) ||
    []) as string[];

  // Detect service / token kinds via Keycloak claim conventions.
  const kind: SubjectKind =
    (auth?.azp as string | undefined)?.startsWith("svc-") ? "service" :
    (auth?.token_type as string | undefined) === "pat" ? "token" :
    "user";

  return { kind, identifier, roles, groups, markings };
}

/**
 * Convenience wrapper that emits Prometheus + structured-log on decision.
 * Caller must still write the cbac_decision_log row via the SQL helper.
 */
export function evaluateAndObserve(
  subject: Subject,
  policy: Policy | null,
  context: PolicyContext,
): Decision {
  const decision = evaluate(subject, policy, context);
  incCounter(
    decision.decision === "allow"
      ? "tellus_cbac_allow_total"
      : "tellus_cbac_deny_total",
    {
      resource_kind: context.resourceKind,
      reason: decision.reason,
      subject_kind: subject.kind,
    },
  );
  return decision;
}
