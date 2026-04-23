// ---------------------------------------------------------------------------
// src/validation/queryLimits.ts
//
// Block F item 3 — validation-time rejects on /searchAround and multi-hop
// routes to prevent the F-P5-01/F-P5-02 N+1 explosion from ever entering
// the handler.
//
// Caller pattern:
//   import { assertQueryLimits } from "../validation/queryLimits";
//   assertQueryLimits.multiHop(req.body);
//   assertQueryLimits.searchAround(req.body);
//
// Each throws OntologyError("QUERY_TOO_LARGE", 400) with a descriptive
// message. The 4xx is intentional — this is a client-side shape problem,
// not a server error.
// ---------------------------------------------------------------------------

import { appError } from "../utils/appError";

const MAX_MULTIHOP_STEPS = 3;
const MAX_MULTIHOP_STARTING_PKS = 100;
const MAX_SEARCHAROUND_SOURCE_PKS = 1_000;

export const assertQueryLimits = {
  multiHop(body: { steps?: unknown[]; startingPKs?: unknown[] }): void {
    const steps = body.steps?.length ?? 0;
    const startingPKs = body.startingPKs?.length ?? 0;
    if (steps > MAX_MULTIHOP_STEPS) {
      throw appError(
        "QUERY_TOO_LARGE",
        `multi-hop traversal limited to ${MAX_MULTIHOP_STEPS} steps; got ${steps}`,
        { statusCode: 400 },
      );
    }
    if (startingPKs > MAX_MULTIHOP_STARTING_PKS) {
      throw appError(
        "QUERY_TOO_LARGE",
        `multi-hop traversal limited to ${MAX_MULTIHOP_STARTING_PKS} starting PKs; got ${startingPKs}`,
        { statusCode: 400 },
      );
    }
  },

  searchAround(body: { sourceCount?: number }): void {
    const n = body.sourceCount ?? 0;
    if (n > MAX_SEARCHAROUND_SOURCE_PKS) {
      throw appError(
        "QUERY_TOO_LARGE",
        `searchAround source PK set limited to ${MAX_SEARCHAROUND_SOURCE_PKS}; got ${n}`,
        { statusCode: 400 },
      );
    }
  },
} as const;

export const QUERY_LIMITS = {
  MAX_MULTIHOP_STEPS,
  MAX_MULTIHOP_STARTING_PKS,
  MAX_SEARCHAROUND_SOURCE_PKS,
} as const;
