// ---------------------------------------------------------------------------
// Trace context middleware — PB-B9.
//
// * Generate (or honour an inbound `X-Trace-Id` header) a trace_id per
//   request.
// * Put the context into AsyncLocalStorage so downstream code paths
//   (route handlers → services → activities → DB) can emit structured
//   logs tagged with the same trace_id without plumbing it manually.
// * Echo the trace_id on every response — `X-Trace-Id` — so when a
//   user hits a 500, they can paste the header into a support ticket
//   and SRE can search logs by it (acceptance (e)).
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from "express";
import {
  newSpanId,
  newTraceId,
  withTraceFields,
} from "../services/traceContext";

const HEADER = "x-trace-id";

export function traceContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.header(HEADER);
  const traceId = isValidTraceId(inbound) ? (inbound as string) : newTraceId();
  const spanId = newSpanId();
  // Surface on the response immediately so even early error handlers
  // that return before res.end() still carry the header.
  res.setHeader("X-Trace-Id", traceId);
  res.setHeader("X-Span-Id", spanId);
  // Run the rest of the request lifecycle inside an ALS context so any
  // code path — controller, service, DB driver — can read the trace.
  withTraceFields({ traceId, spanId }, () => next());
}

function isValidTraceId(v: string | undefined): boolean {
  return typeof v === "string" && /^[a-f0-9-]{16,64}$/i.test(v);
}
