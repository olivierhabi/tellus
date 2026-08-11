import { executeAction } from "../../actions/actionExecutor";
import { pool } from "../../db";
import { evaluatePindoFailover, type AutomationState, type CarrierSample, type FailoverPolicy } from "./pindoAutomation";

const ROUTE_TYPE = "QaRwPindoCarrierRoutes";
const IDENTITY = "rwanda-pindo-automation";

const policyFor = (properties: Record<string, unknown>): FailoverPolicy => ({
  breachThresholdMs: Number(properties.threshold ?? 1_000),
  breachHoldDownMs: Number(properties.breachHoldDown ?? 300) * 1_000,
  recoveryHoldDownMs: Number(properties.recoveryHoldDown ?? 600) * 1_000,
  maxFailoversPerWindow: Number(properties.maxFailoversPerWindow ?? 1),
  rateWindowMs: 3_600_000,
  killSwitch: String(properties.killSwitch ?? "false") !== "true",
  maxTelemetryGapMs: 60_000,
});

/** Executes the real one-minute Pindo policy against persisted route objects. */
export async function runRwandaPindoAutomationOnce(now = new Date()): Promise<number> {
  const routes = await pool.query<{ ontology_id: string; primary_key: string; properties: Record<string, unknown>; last_modified_at: string }>(
    `SELECT ontology_id, primary_key, properties, last_modified_at
       FROM object_instances WHERE object_type_api_name = $1`, [ROUTE_TYPE],
  );
  let evaluated = 0;
  for (const route of routes.rows) {
    const properties = route.properties ?? {};
    const stateRow = await pool.query<{ state: AutomationState }>(
      `SELECT state FROM rwanda_pindo_automation_state WHERE ontology_id = $1 AND route_id = $2`,
      [route.ontology_id, route.primary_key],
    );
    const prior = stateRow.rows[0]?.state ?? { activeRoute: "primary", failovers: [] };
    const sample: CarrierSample = {
      measuredAt: String(properties.measuredAt ?? route.last_modified_at),
      latencyMs: Number(properties.p95Latency),
      errorRate: Number(properties.errorRate ?? 0),
    };
    const decision = evaluatePindoFailover([sample], policyFor(properties), prior, now.toISOString());
    let actionExecutionId: string | null = null;
    if (decision.outcome === "FAILOVER") {
      const execution = await executeAction(route.ontology_id, "qaRwPindoSwitchCarrierRoute", {
        routeId: route.primary_key,
        targetRoute: String(properties.targetRoute ?? "fallback-healthy"),
        reason: "Automated sustained Pindo carrier breach",
      }, {
        executedBy: IDENTITY,
        roles: ["ops-engineer"],
        correlationId: `rwanda-pindo-automation:${route.primary_key}:${now.toISOString()}`,
      });
      actionExecutionId = execution.executionId;
    }
    await pool.query(
      `INSERT INTO rwanda_pindo_automation_state (ontology_id, route_id, state)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (ontology_id, route_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [route.ontology_id, route.primary_key, JSON.stringify(decision.state)],
    );
    await pool.query(
      `INSERT INTO rwanda_pindo_automation_audit
       (ontology_id, route_id, outcome, reason, service_identity, action_execution_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [route.ontology_id, route.primary_key, decision.outcome, decision.reason, IDENTITY, actionExecutionId],
    );
    evaluated += 1;
  }
  return evaluated;
}
