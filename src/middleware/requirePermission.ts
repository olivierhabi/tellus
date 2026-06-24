// ---------------------------------------------------------------------------
// requirePermission — Foundry-faithful permission middleware (B4.11).
//
// Wraps gatekeeperService.evaluate(). Pulls the principal id from
// req.user.id (set by tellusAuth/globalAuth) and the resource RID from
// either req.params.rid or req.compassRid (set by an upstream resolver).
//
// On DENY, throws a 403 NotAuthorizedError carrying the reason in the
// `errorInstanceId`-suffixed payload so the foundryErrorHandler renders
// the standard envelope.
// ---------------------------------------------------------------------------
import type { Request, Response, NextFunction } from "express";
import { gatekeeperService } from "../services/gatekeeperService";

export interface RequirePermissionOptions {
  ridFrom?: (req: Request) => string | undefined;
}

export function requirePermission(
  operationId: string,
  opts: RequirePermissionOptions = {},
) {
  return async function requirePermissionMw(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const user = (req as Request & { user?: { id: string } }).user;
      if (!user?.id) {
        const e = new Error("Unauthenticated");
        (e as Error & { status?: number; errorName?: string }).status = 401;
        (e as Error & { errorName?: string }).errorName = "NotAuthenticated";
        return next(e);
      }
      const rid =
        (opts.ridFrom?.(req)) ??
        (req.params.rid as string | undefined) ??
        ((req as Request & { compassRid?: string }).compassRid);
      if (!rid) {
        const e = new Error("Missing resource RID");
        (e as Error & { status?: number; errorName?: string }).status = 400;
        (e as Error & { errorName?: string }).errorName = "InvalidArgument";
        return next(e);
      }
      const decision = await gatekeeperService.evaluate({
        principalId: user.id,
        operationId,
        resourceRid: rid,
      });
      if (decision.decision === "ALLOW") return next();
      const e = new Error(`PERMISSION_DENIED: ${(decision as { reason: string }).reason}`);
      (e as Error & { status?: number; errorName?: string; code?: string }).status = 403;
      (e as Error & { errorName?: string }).errorName = "PermissionDenied";
      (e as Error & { code?: string }).code = "PERMISSION_DENIED";
      (e as Error & { reason?: string }).reason = (decision as { reason: string }).reason;
      return next(e);
    } catch (err) {
      next(err);
    }
  };
}
