// ---------------------------------------------------------------------------
// src/middleware/cbac.ts
//
// Express middleware factory for CBAC enforcement on data-plane routes.
// Closes the integration half of F-P3-18 (CBAC absent on /actions,
// /search, /audit, /branches).
//
// Usage pattern at the route handler:
//
//   router.post(
//     "/actionTypes/:apiName/apply",
//     requireCbac(async (req) => ({
//       resourceKind: "action_type",
//       resourceId: req.params.apiName,
//       ontologyId: req.params.ontologyId ?? null,
//       loadPolicy: () => loadActionTypePolicy(req.params.ontologyId ?? null, req.params.apiName),
//     })),
//     existingHandler,
//   );
//
// The middleware:
//   1. Builds a Subject from req.security / req.auth.
//   2. Calls loadPolicy() — either an action-type lookup, a branch
//      lookup, or a static policy for search/audit.
//   3. Calls evaluateAndObserve(subject, policy, context).
//   4. Logs the decision to cbac_decision_log (best-effort).
//   5. On deny: returns 403 with a Conjure-shaped error.
//   6. On allow: attaches the decision to req.__cbacDecision and calls next().
//
// The boot-time guard at src/server.ts asserts that every data-plane
// route reads req.security — the CBAC middleware is one of the two
// ways a route "reads req.security" (the other is a direct reference).
// Routes without this middleware and without direct req.security usage
// fail the server boot self-check.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  evaluateAndObserve,
  subjectFromRequest,
  type Decision,
  type Policy,
  type PolicyContext,
} from "../services/security/cbacPolicy";
import { logCbacDecision } from "../services/security/cbacDecisionLog";
import { incCounter } from "../services/funnel/metrics";

export interface CbacContextBuilder {
  (req: Request): Promise<{
    resourceKind: string;
    resourceId: string;
    ontologyId?: string | null;
    loadPolicy: () => Promise<Policy | null>;
  }> | {
    resourceKind: string;
    resourceId: string;
    ontologyId?: string | null;
    loadPolicy: () => Promise<Policy | null>;
  };
}

/**
 * Middleware factory. Returns an Express middleware that enforces CBAC
 * using the context supplied by `buildContext`.
 */
export function requireCbac(buildContext: CbacContextBuilder): RequestHandler {
  return async function cbacMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
      const built = await buildContext(req);
      const context: PolicyContext = {
        resourceKind: built.resourceKind,
        resourceId: built.resourceId,
        ontologyId: built.ontologyId ?? null,
        sourceIp:
          ((req.headers["x-forwarded-for"] as string | undefined) || "").split(",")[0]?.trim() ||
          req.ip ||
          null,
        requestId: ((req as any).requestId as string | undefined) ?? null,
      };
      const policy = await built.loadPolicy();
      const subject = subjectFromRequest(req);
      const decision = evaluateAndObserve(subject, policy, context);

      // Best-effort forensic log. Does not block on failure.
      void logCbacDecision(subject, decision, context);

      if (decision.decision === "deny") {
        incCounter("tellus_cbac_denials_total", {
          resource_kind: context.resourceKind,
          reason: decision.reason,
        });
        res.status(403).json({
          errorCode: "PERMISSION_DENIED",
          errorName: "PermissionDenied",
          message: cbacDenyMessage(decision),
          statusCode: 403,
          parameters: {
            resource_kind: context.resourceKind,
            resource_id: context.resourceId,
            reason: decision.reason,
          },
        });
        return;
      }

      // Attach the allow decision for downstream observability.
      (req as any).__cbacDecision = decision;
      next();
    } catch (err) {
      // A CBAC evaluation error MUST fail closed — do not fall through
      // to the handler. Otherwise a transient DB hiccup becomes a
      // silent authorization bypass.
      incCounter("tellus_cbac_errors_total", {
        reason: err instanceof Error ? err.constructor.name : "unknown",
      });
      res.status(503).json({
        errorCode: "AUTHORIZATION_UNAVAILABLE",
        errorName: "AuthorizationUnavailable",
        message:
          "CBAC evaluation temporarily unavailable; request cannot be authorized. Retry after a short backoff.",
        statusCode: 503,
      });
    }
  };
}

function cbacDenyMessage(decision: Decision): string {
  switch (decision.reason) {
    case "anonymous_denied":
      return "Authentication required for this resource.";
    case "denylist_match":
      return "Access explicitly denied by policy.";
    case "no_allowlist_match":
      return "Subject is not on the allowlist for this resource.";
    case "markings_insufficient":
      return "Subject does not hold the markings required for this resource.";
    case "missing_policy_default_deny":
      return "No policy is defined for this resource; default-deny applies.";
    case "allow":
      // Unreachable under normal control flow (allow is handled upstream),
      // but defensive branches must stay exhaustive.
      return "Access permitted.";
  }
}
