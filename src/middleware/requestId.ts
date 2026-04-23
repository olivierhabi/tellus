// ---------------------------------------------------------------------------
// src/middleware/requestId.ts
//
// F-P4-03 closure — inbound X-Request-ID propagation.
//
// Previous behaviour: errorHandler.ts:268 manufactured a requestId if
// `req.requestId` was missing, but never adopted an inbound `X-Request-ID`
// header. Any upstream correlation id from an ingress, API gateway, or
// client was silently dropped — the error row and the distributed trace
// observer used a fresh UUID while the client's support ticket referenced
// the original.
//
// Post-fix behaviour:
//   1. Inbound `X-Request-ID` is honoured when present and conforms to a
//      safe pattern (UUID v4, ULID, or a simple alphanumeric/dash string
//      of length ≤ 128). Non-conforming values are replaced with a fresh
//      UUID to prevent log injection.
//   2. `req.requestId` and the `X-Request-ID` response header both reflect
//      the adopted value.
//   3. A Prometheus counter tracks adoption vs fresh-mint rates so an
//      operator can see whether upstream correlation is working.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { incCounter } from "../services/funnel/metrics";

/** UUID (any version) OR ULID OR short alphanumeric / dash / underscore. */
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function isSafeRequestId(v: unknown): v is string {
  return typeof v === "string" && SAFE_REQUEST_ID_RE.test(v);
}

export function requestId() {
  return function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers["x-request-id"];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

    let adopted: string;
    let source: "inbound" | "minted";
    if (isSafeRequestId(candidate)) {
      adopted = candidate;
      source = "inbound";
    } else {
      adopted = crypto.randomUUID();
      source = "minted";
    }

    (req as Request & { requestId: string }).requestId = adopted;
    res.setHeader("X-Request-ID", adopted);

    try {
      incCounter("tellus_request_id_origin_total", { source });
    } catch {
      // metrics unavailable during early boot — silent is acceptable
    }

    next();
  };
}

export default requestId;
