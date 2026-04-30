// ---------------------------------------------------------------------------
// currentUser.ts — single source of truth for "who is calling".
//
// T-06: replaces every `(req as any).user?.id || "system"` /
// `?? "system"` fallback in the explorer surface. The pre-T-06 pattern
// silently substituted the literal string "system" for an unauthenticated
// request, which (a) leaked unscoped queries to phantom users and (b) made
// audit logs lie about the principal. This helper fails closed: if
// `req.user.id` is missing or empty, it throws `UNAUTHORIZED` (HTTP 401)
// which the global error handler converts into the canonical envelope.
//
// Routes that legitimately operate without a human user (system jobs,
// internal pipelines) MUST NOT call this helper — they should use
// `req.security.systemPrincipal` instead, set by the securityContext
// middleware. Mixing the two is a category error: a system principal is
// not "user system", it is "no user."
// ---------------------------------------------------------------------------

import type { Request } from "express";
import { appError } from "../utils/appError";

/**
 * Return the authenticated user id. Throws `UNAUTHORIZED` (HTTP 401) when
 * the request carries no user context. Catches both the missing-property
 * case and the empty-string case (which previously fell through to the
 * "system" fallback).
 *
 * The thrown error is an `AppError`, propagated to the global error
 * handler — callers do not need a try/catch around this helper.
 */
export function currentUser(req: Request): string {
  const user = (req as Request & { user?: { id?: string } }).user;
  const id = user?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw appError(
      "UNAUTHORIZED",
      "Missing authenticated user context.",
    );
  }
  return id;
}
