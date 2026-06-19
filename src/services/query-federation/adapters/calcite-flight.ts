// ---------------------------------------------------------------------------
// B8 — Calcite + Arrow Flight SQL adapter stub (spec §B8 line 405).
//
// Functional tests deferred (DEFERRED.md: needs JVM sidecar with Calcite +
// arrow-flight-sql-jdbc). Surface is stable so callers can swap via
// TELLUS_FEDERATION_ADAPTER=calcite-flight.
// ---------------------------------------------------------------------------

import type {
  FederationEngineAdapter,
  ExecutionResult,
  PushdownPlan,
  QueryPlan,
} from "../engine-adapter";

export class CalciteFlightUnsupported extends Error {
  constructor(method: string) {
    super(
      `CalciteFlightAdapter.${method}: stubbed (DEFERRED.md). Use TELLUS_FEDERATION_ADAPTER=node-sql-builder.`,
    );
    this.name = "CalciteFlightUnsupported";
  }
}

export function createCalciteFlightAdapter(): FederationEngineAdapter {
  return {
    async execute(_plan: QueryPlan): Promise<ExecutionResult> {
      throw new CalciteFlightUnsupported("execute");
    },
    async explain(_plan: QueryPlan): Promise<PushdownPlan> {
      throw new CalciteFlightUnsupported("explain");
    },
  };
}
