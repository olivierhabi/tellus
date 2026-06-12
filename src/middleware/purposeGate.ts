// ---------------------------------------------------------------------------
// src/middleware/purposeGate.ts — FOUNDRY-GAPS §8 (purpose-based access).
//
// Opt-in gate for GOVERNED data-plane reads. Foundry semantics: a caller
// must DECLARE a purpose (X-Tellus-Purpose: <apiName>) before reading
// governed data, and the declared purpose is logged with every access
// (it lands in the read-audit row via readAudit.ts).
//
// Enforcement is env-gated: TELLUS_PURPOSE_ENFORCEMENT=on enables it;
// anything else (including unset — the default) is a strict no-op, so
// rolling this middleware onto routes is a zero-behavior-change deploy.
//
// Per-request flow when enforcement is ON:
//   1. Resolve whether the addressed resource is governed
//      (object_type.governed_purpose_required — or a custom resolver for
//      dataset-keyed routes). Not governed → pass through.
//   2. Require the X-Tellus-Purpose header → 403 PURPOSE_REQUIRED.
//   3. purposeService.checkPurpose() validates existence, expiry, grant,
//      and category → 403 with the typed denial code on failure.
//   4. On success, stash the purpose on res.locals.declaredPurpose so the
//      readAudit finish-hook stamps it into the audit row.
//
// Fail-closed on resolver/service errors: if we cannot determine whether
// access is permitted, governed data is NOT served.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { sendError } from "../utils/responseFormatter";
import type { ReadCategory } from "./readAudit";
import {
  checkPurpose,
  isObjectTypeGoverned,
  PURPOSE_REQUIRED,
} from "../services/governance/purposeService";

export const PURPOSE_HEADER = "x-tellus-purpose";

export function purposeEnforcementEnabled(): boolean {
  return process.env.TELLUS_PURPOSE_ENFORCEMENT === "on";
}

function principalOf(req: Request): string {
  const anyReq = req as any;
  return (
    anyReq.auth?.preferred_username ||
    anyReq.auth?.sub ||
    anyReq.user?.email ||
    anyReq.user?.id ||
    "anonymous"
  );
}

function groupsOf(req: Request): string[] {
  const anyReq = req as any;
  const groups = anyReq.auth?.groups ?? anyReq.user?.groups ?? [];
  return Array.isArray(groups) ? groups.map(String) : [];
}

export interface PurposeGateOptions {
  /**
   * Resolve whether the addressed resource is governed. Defaults to the
   * object-type flag (object_type.governed_purpose_required) keyed on
   * req.params.ontologyId + req.params.objectTypeApiName. Routes governed
   * at another granularity (e.g. dataset-backed) pass their own resolver.
   */
  isGoverned?: (req: Request) => Promise<boolean>;
}

async function defaultIsGoverned(req: Request): Promise<boolean> {
  const ontologyId = req.params?.ontologyId;
  const objectTypeApiName =
    req.params?.objectTypeApiName ?? req.params?.objectType;
  if (!ontologyId || !objectTypeApiName) return false;
  return isObjectTypeGoverned(ontologyId, objectTypeApiName);
}

/**
 * Express middleware factory. `category` is the read-audit category the
 * mounted route exercises (the same one the handler passes to
 * annotateReadAudit) — a purpose must list it in allowed_categories.
 */
export function purposeGate(category: ReadCategory, opts: PurposeGateOptions = {}) {
  const resolveGoverned = opts.isGoverned ?? defaultIsGoverned;

  return async function purposeGateMw(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Default-off: zero behavior change unless explicitly enabled.
    if (!purposeEnforcementEnabled()) {
      next();
      return;
    }

    try {
      const governed = await resolveGoverned(req);
      if (!governed) {
        next();
        return;
      }

      const declared = (req.headers[PURPOSE_HEADER] as string | undefined)?.trim();
      const decision = await checkPurpose({
        principalId: principalOf(req),
        groups: groupsOf(req),
        purposeApiName: declared ?? null,
        category,
        ontologyId: req.params?.ontologyId ?? "",
      });

      if (!decision.allowed) {
        sendError(res, decision.code ?? PURPOSE_REQUIRED, decision.reason, {
          category,
          declaredPurpose: declared ?? null,
        });
        return;
      }

      // Make the validated purpose visible to the readAudit finish-hook
      // (and to handlers that want to echo it).
      res.locals.declaredPurpose = decision.purpose?.apiName ?? declared;
      next();
    } catch (err) {
      // Fail closed: governed data is not served when the gate itself errors.
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, "FORBIDDEN", `Purpose gate could not authorize this read: ${message}`, {
        category,
      });
    }
  };
}

export default { purposeGate, purposeEnforcementEnabled, PURPOSE_HEADER };
