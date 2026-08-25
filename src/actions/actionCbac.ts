// ---------------------------------------------------------------------------
// src/actions/actionCbac.ts — Phase 6.1 action-dispatch authorization gate.
//
// Small, pure-ish helper that wraps the existing CBAC layer
// (`cbacPolicy.evaluate` + `cbacPolicyLoader.loadActionTypePolicy` +
// `cbacDecisionLog.logCbacDecision`) so the actionExecutor can call it as a
// single Stage-1c unit. The helper is the only surface the executor needs to
// know about; the policy shape, the LRU cache, and the forensic-logging
// contract are owned by `src/services/security/*`.
//
// Why extract this from actionExecutor.ts?
//
//   1. Unit-testability. The actionExecutor itself drags in PG, OpenSearch,
//      the applyEdits transaction, the writeback executor, the side-effect
//      outbox — each of which adds its own mock surface. Stage 1c here is
//      a 4-call slice (load → evaluate → log → return) that's trivially
//      unit-testable with mocked CBAC services.
//
//   2. Reuse. The bulk-action runner and the applyBatch path can call the
//      SAME gate directly rather than re-wiring `evaluate` + `loadActionTypePolicy`
//      each time. The legacy /validate route can also call it for parity
//      (validation should refuse to preview an action the actor cannot
//      actually run — coincidentally fixing an unrelated Phase 1
//      correctness gap).
//
//   3. Observability seam. `runActionCbacGate` returns the structured Decision;
//      its caller owns the failure surface (OntologyError → 403/503). Tests
//      can assert on `decision.reason` without having to parse error
//      envelopes.
//
// Fail-closed semantics (F-P3-18 §4):
//
//   * Policy-loader failure (PG drop) → AUTHORIZATION_UNAVAILABLE (503).
//   * Evaluator exception → AUTHORIZATION_UNAVAILABLE (503).
//   * Decision.decision === "deny" → PERMISSION_DENIED (403) with the
//     structured `matchedRule` payload (denied principal + reason +
//     missing markings) in the resulting OntologyError.details.
//   * Decision.decision === "allow" → NO_OP (caller proceeds).
//
// Backward-compat guarantee:
//
//   * The loader returns a permissive Policy for an action_type row whose
//     columns are all NULL (`allowedPrincipals=null, deniedPrincipals=null,
//     requiredMarkings=[]`). For any authenticated non-anonymous subject,
//     `evaluateCbacPolicy` returns ALLOW. So wiring the gate into the
//     executor NEVER breaks a default action row — only rows that have
//     EXPlicitly declared a policy are bound by it.
// ---------------------------------------------------------------------------

import type { Subject, Policy, PolicyContext, Decision } from "../services/security/cbacPolicy";
import {
  evaluate as evaluateCbacPolicy,
} from "../services/security/cbacPolicy";
import {
  loadActionTypePolicy,
} from "../services/security/cbacPolicyLoader";
import { logCbacDecision } from "../services/security/cbacDecisionLog";

/** Resulting structured result of the gate — caller converts a `deny` to
 * the appropriate OntologyError. */
export interface CbacGateResult {
  decision: "allow" | "deny";
  reason: Decision["reason"];
  /** Surfaces the matched selector or the missing-markings list. Null on
   * allow. */
  matchedRule: Decision["matchedRule"];
  /** `null` when the gate ran cleanly; a structured error code when the gate
   * itself failed (loader/evaluator exception). Callers map this to a 503
   * `AUTHORIZATION_UNAVAILABLE`. */
  internalError: { code: string; detail: string } | null;
}

/** Build a `Subject` from an ExecutionContext's security-shaped fields. The
 * markBypass flag is NOT threaded into the Subject (the pure evaluator
 * doesn't have a bypass notion) — `runActionCbacGate` overrides the
 * markings_insufficient outcome post-evaluation when the caller has
 * requested bypass. Mirrors `buildSecurityFilter` line 246. */
export function subjectFromSecurity(security: {
  subjectKind: "user" | "service" | "token" | "anonymous";
  subjectIdentifier: string;
  roles?: string[];
  groups?: string[];
  subjectMarkings?: string[];
  markBypass?: boolean;
}): Subject {
  return {
    kind: security.subjectKind,
    identifier: security.subjectIdentifier,
    roles: security.roles ?? [],
    groups: security.groups ?? [],
    markings: security.subjectMarkings ?? [],
  };
}

/**
 * Run the CBAC gate for an action-type dispatch. Loads the policy for the
 * (ontologyId, apiName) pair, builds a Subject from the security fields,
 * evaluates, and best-effort logs the decision. NEVER throws: the caller
 * inspects the structured result + maps `deny` / `internalError` to the
 * appropriate OntologyError.
 *
 * @param ontologyId - ontology UUID (may be null for legacy global resources).
 * @param actionTypeApiName - the action's apiName.
 * @param security - thread-shaped `ExecutionContext` security fields. When
 *   `subjectKind` is `undefined` the gate is SKIPPED (returns ALLOW) — this
 *   is the backward-compat path for callers that didn't thread security.
 *   In Phase 6.1 the routes/actions.ts threads security ONLY if
 *   `req.security` is populated by the global `securityContext` middleware,
 *   so all production dispatch paths get the gate; the test hopper is
 *   allowed to skip.
 * @param policyCtx - the Context for `cbacDecisionLog`.
 */
export async function runActionCbacGate(
  ontologyId: string | null,
  actionTypeApiName: string,
  security: {
    subjectKind?: "user" | "service" | "token" | "anonymous";
    subjectIdentifier?: string;
    roles?: string[];
    groups?: string[];
    subjectMarkings?: string[];
    markBypass?: boolean;
  },
  policyCtx: PolicyContext,
): Promise<CbacGateResult> {
  // Backward-compat: when the caller didn't thread security, the gate
  // is skipped — enables test + integration hopper paths that don't go
  // through Keycloak.
  if (security.subjectKind === undefined) {
    return { decision: "allow", reason: "allow", matchedRule: null, internalError: null };
  }
  const subject = subjectFromSecurity(security as any);
  // Load the policy. Denylist still applies even with a populated
  // subject; if the policy explicitly denies this principal, ALLOW
  // short-circuit via markBypass doesn't beat a denylist rule (this
  // mirrors cbacPolicy.ts step 1 ordering).
  let policy: Policy | null;
  try {
    policy = await loadActionTypePolicy(ontologyId, actionTypeApiName);
  } catch (err: any) {
    return {
      decision: "deny",
      reason: "missing_policy_default_deny",
      matchedRule: null,
      internalError: {
        code: "AUTHORIZATION_UNAVAILABLE",
        detail: err?.message ?? String(err),
      },
    };
  }
  let decision: Decision;
  try {
    decision = evaluateCbacPolicy(subject, policy, policyCtx);
  } catch (err: any) {
    return {
      decision: "deny",
      reason: "missing_policy_default_deny",
      matchedRule: null,
      internalError: {
        code: "AUTHORIZATION_UNAVAILABLE",
        detail: err?.message ?? String(err),
      },
    };
  }
  // Marking-bypass (superadmin / systemPrincipal): mirrors
  // `buildSecurityFilter` line 246. Once the denylist step has run,
  // a marking-bypass superadmin short-circuits the markings-cover
  // gate (but NOT the denylist — see cbacPolicy.ts step 1 ordering).
  // We don't pass an "allow on markBypass" flag into the pure
  // evaluator (which intentionally has no IO notion); instead we
  // override the markings_insufficient outcome here.
  if (
    security.markBypass &&
    decision.decision === "deny" &&
    decision.reason === "markings_insufficient"
  ) {
    decision = { decision: "allow", reason: "allow", matchedRule: null };
  }
  // Best-effort forensic log — never blocks the action on its own failure.
  try {
    await logCbacDecision(subject, decision, policyCtx);
  } catch {
    /* swallow */
  }
  return {
    decision: decision.decision,
    reason: decision.reason,
    matchedRule: decision.matchedRule,
    internalError: null,
  };
}

/** Human-readable error message for a `deny` decision. Phase 6.1 ships
 * the executor's call site that uses this. */
export function cbacDenyMessage(result: CbacGateResult): string {
  if (result.reason === "markings_insufficient" && result.matchedRule && "missing" in (result.matchedRule as any)) {
    return `Missing required markings: ${(result.matchedRule as any).missing.join(", ")}`;
  }
  switch (result.reason) {
    case "anonymous_denied":
      return "Anonymous access is not permitted for this action type.";
    case "denylist_match":
      return "Principal is explicitly denied for this action type.";
    case "no_allowlist_match":
      return "Principal is not in the action type's allowlist.";
    case "missing_policy_default_deny":
      return "No CBAC policy was found for this action type — fail-closed.";
    case "markings_insufficient":
      return "Missing required markings.";
    default:
      return "Access to this action type is denied by policy.";
  }
}
