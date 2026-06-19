// ---------------------------------------------------------------------------
// B8 — Federation module entrypoint (spec §B8 line 402).
//
// Exports createFederationRouter() for /api/v2/federation. The route wiring
// is intentionally minimal — the heavy work happens in the adapter.
// ---------------------------------------------------------------------------

import { Router } from "express";
import { postQuery } from "./handlers";
import { postExplain } from "./handlers/explain";

export function createFederationRouter(): Router {
  const r = Router({ mergeParams: true });
  r.post("/query", postQuery);
  r.post("/explain", postExplain);
  return r;
}

export type {
  QueryPlan,
  PushdownPlan,
  FederationEngineAdapter,
  PredicateNode,
  FilterNode,
} from "./engine-adapter";
