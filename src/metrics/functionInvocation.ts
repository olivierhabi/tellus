// ---------------------------------------------------------------------------
// functionInvocation.ts — Prometheus metrics for Function-effect execution.
//
// Counters (served by the shared prom-client registry, same pattern as
// src/metrics/funnelProjection.ts):
//
//   tellus_function_effect_executions_total{contract,status}
//     Every Function-effect execution attempt by invocation contract. The
//     `contract` label is the persisted invocation contract — the ratio
//     legacy/total is THE legacy-migration burndown signal.
//
//   tellus_function_legacy_contract_executions_total
//     Dedicated low-noise counter for legacy-contract executions; alert on
//     rate() > 0 after the announced deprecation date.
//
// Labels carry NO parameter values, no artifact content, no user input —
// contract + coarse status only.
// ---------------------------------------------------------------------------

import { Counter, register } from "prom-client";

function getOrCreateCounter(
  opts: ConstructorParameters<typeof Counter>[0],
): Counter<string> {
  const existing = register.getSingleMetric(opts.name);
  if (existing) return existing as Counter<string>;
  return new Counter(opts);
}

export const functionEffectExecutionsTotal = getOrCreateCounter({
  name: "tellus_function_effect_executions_total",
  help: "Function-effect execution attempts by invocation contract and status.",
  labelNames: ["contract", "status"] as const,
});

export const functionLegacyContractExecutionsTotal = getOrCreateCounter({
  name: "tellus_function_legacy_contract_executions_total",
  help: "Executions on the deprecated legacy-object-envelope-v1 invocation contract (migration burndown signal).",
  labelNames: ["status"] as const,
});
