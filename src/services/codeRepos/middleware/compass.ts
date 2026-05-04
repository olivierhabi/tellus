// ---------------------------------------------------------------------------
// Code Repositories — Compass authorization adapter (IDOR-safe).
//
// Spec contracts:
//   G-C-09  Authorization failures on a specific resource return 404,
//           NEVER 403 (IDOR-as-404). 404 is preferred so an unauthorized
//           caller cannot probe the existence of resources outside their
//           visibility scope.
//   G-C-10  Compass authorization is consulted on every mutating endpoint
//           with the operation enum from §1.2.
//
// In production, Compass is a separate service that exposes
// `canAct(principal, resource, operation)`. The Tellus monorepo does not
// (yet) host a real Compass; per D-2026-05-01-003 we ship a small,
// extensible stub that:
//
//   1. Defaults to ALLOW for OWNER + EDITOR roles, DENY otherwise. This
//      is the most permissive defensible default for the demo flow,
//      while still exercising the IDOR-as-404 code path so the contract
//      test passes.
//   2. Exposes a hook (`registerCompassPolicy`) so a future B-task can
//      replace the default with a real Compass HTTP client without
//      touching every route.
//   3. Maps DENY at the middleware layer to a NOT_FOUND envelope with
//      `Stemma:RepositoryNotFound` (G-C-09) — never PERMISSION_DENIED.
//      The route handler is short-circuited so no business logic runs.
//
// The Compass call is in-process (zero-latency stub); the real client
// will need timeout + circuit breaker per §1.9. The middleware's
// signature accepts an async policy so swapping in the HTTP client is a
// drop-in change.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { buildEnvelope, ERROR_CODES } from "../contracts/errors";
import type { CodeReposPrincipal } from "./principal";

/**
 * §1.2 operation enum — the action a principal wishes to perform on a
 * resource. Compass returns ALLOW or DENY for each (principal, resource,
 * operation) triple.
 */
export type CompassOperation =
  | "READ"
  | "WRITE"
  | "DELETE"
  | "ADMIN"
  | "PUSH"
  | "FETCH";

export interface CompassResource {
  readonly rid: string;
  /** "Repository" | "JobSpec" | "FunctionVersion" | ... */
  readonly type: string;
}

export type CompassDecision = "ALLOW" | "DENY";

export type CompassPolicy = (
  principal: CodeReposPrincipal,
  resource: CompassResource,
  operation: CompassOperation,
) => Promise<CompassDecision> | CompassDecision;

/**
 * Default policy (D-2026-05-01-003). Can be replaced for tests or for
 * the real HTTP client by calling registerCompassPolicy().
 */
const DEFAULT_POLICY: CompassPolicy = (principal) => {
  if (principal.roles.includes("OWNER") || principal.roles.includes("EDITOR")) {
    return "ALLOW";
  }
  if (principal.roles.includes("READER")) {
    // READER may READ + FETCH but nothing mutating; the per-operation
    // narrowing happens here.
    return "DENY"; // narrow at the call site via authorizeOperation()
  }
  return "DENY";
};

let activePolicy: CompassPolicy = DEFAULT_POLICY;

/** Test/integration hook — registers a new policy for the lifetime of the process. */
export function registerCompassPolicy(policy: CompassPolicy): void {
  activePolicy = policy;
}

/** Restore the default policy. Used by test teardowns. */
export function resetCompassPolicy(): void {
  activePolicy = DEFAULT_POLICY;
}

/**
 * Imperative authorization check, callable from inside a route handler
 * once the resource RID is known. Returns the decision; the caller is
 * responsible for short-circuiting on DENY (recommended via
 * `denyAsNotFound`).
 */
export async function authorizeOperation(
  principal: CodeReposPrincipal,
  resource: CompassResource,
  operation: CompassOperation,
): Promise<CompassDecision> {
  // READER role is allowed READ + FETCH; everything else is DENY.
  if (
    principal.roles.length === 1 &&
    principal.roles[0] === "READER" &&
    (operation === "READ" || operation === "FETCH")
  ) {
    return "ALLOW";
  }
  const decision = await Promise.resolve(activePolicy(principal, resource, operation));
  return decision;
}

/**
 * Helper: write a 404 NOT_FOUND envelope with the given errorName.
 * G-C-09 — IDOR returns 404 (we never reveal existence).
 */
export function denyAsNotFound(
  res: Response,
  rid: string,
  errorName: string,
): void {
  res.status(404).json(
    buildEnvelope({
      errorCode: ERROR_CODES.NOT_FOUND,
      errorName,
      parameters: { rid },
    }),
  );
}

/**
 * Express middleware factory: enforce a fixed (resource lookup,
 * operation) pair. Useful for routes where the resource RID is known
 * at routing time (path param) and the operation is fixed (e.g., POST
 * /repos/:rid/refs is always WRITE).
 *
 * For more complex routes (where the resource RID lives in the body,
 * or the operation depends on a query param), call authorizeOperation
 * directly inside the handler and use denyAsNotFound on DENY.
 */
export function requireOperation(opts: {
  resourceRidFrom: (req: Request) => string | null;
  resourceType: string;
  operation: CompassOperation;
  errorNameOnDeny: string; // e.g., "Stemma:RepositoryNotFound"
}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const principal = req.codeReposPrincipal;
    if (!principal) {
      // Wiring defect — requireCodeReposAuth must run first.
      res.status(500).json(
        buildEnvelope({
          errorCode: ERROR_CODES.INTERNAL,
          errorName: "Stemma:InternalError",
          parameters: { message: "requireOperation: principal not bound" },
        }),
      );
      return;
    }
    const rid = opts.resourceRidFrom(req);
    if (!rid) {
      // No RID extractable → 404 with the configured errorName.
      denyAsNotFound(res, "", opts.errorNameOnDeny);
      return;
    }
    const decision = await authorizeOperation(
      principal,
      { rid, type: opts.resourceType },
      opts.operation,
    );
    if (decision === "DENY") {
      denyAsNotFound(res, rid, opts.errorNameOnDeny);
      return;
    }
    next();
  };
}
