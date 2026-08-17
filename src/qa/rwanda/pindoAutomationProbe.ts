/**
 * QA-only Pindo policy probe for the Rwanda campaign (plan §3.9 functional
 * slice). Mounted exclusively under TELLUS_TEST_HOOKS=1 (see server.ts),
 * exactly like the namespace reset hook.
 *
 * One POST does all three deterministic steps a Playwright journey needs:
 *
 *   1. PATCHES a seeded carrier route's properties (kill switch / telemetry)
 *      directly on the `object_instances` row — the same JSONB-merge pattern
 *      the §6.3 bulk route uses — so reads everywhere stay conventional.
 *   2. RUNS one real policy evaluation immediately
 *      (`runRwandaPindoAutomationOnce`). Timing proofs (hold-down windows,
 *      rate limits) remain Deferred — Performance Program; this hook exists to
 *      prove kill-switch and corrupt-telemetry REFUSALS without waiting real
 *      minutes.
 *   3. READS the durable `rwanda_pindo_automation_audit` rows for the route
 *      back to the caller, newest first.
 *
 * The patch is restricted to QA-RW- primary keys so the hook can never damage
 * non-fixture data (plan §10: all QA data is synthetic).
 */
import type { Request, Response } from "express";

import { query } from "../../db";
import { runRwandaPindoAutomationOnce } from "./pindoAutomationRuntime";

export const RWANDA_PINDO_EVALUATE_ROUTE = "/api/v1/_test/qa/rwanda/pindo/evaluate";

const ROUTE_TYPE = "QaRwPindoCarrierRoutes";
const QA_PREFIX = "QA-RW-";

export async function evaluateRwandaPindoOnce(req: Request, res: Response): Promise<void> {
  const { routeId, patch } = (req.body ?? {}) as {
    routeId?: unknown;
    patch?: unknown;
  };
  if (typeof routeId !== "string" || !routeId.startsWith(QA_PREFIX)) {
    res.status(400).json({ error: "routeId must be a QA-RW- prefixed primary key" });
    return;
  }
  if (patch !== undefined && (patch === null || typeof patch !== "object" || Array.isArray(patch))) {
    res.status(400).json({ error: "patch must be a property object" });
    return;
  }
  try {
    let properties: Record<string, unknown> | null = null;
    if (patch !== undefined) {
      const patched = (await query(
        `UPDATE object_instances
            SET properties = properties || $2::jsonb,
                last_modified_at = now()
          WHERE object_type_api_name = $1
            AND primary_key = $3
            AND primary_key LIKE $4
        RETURNING properties`,
        [ROUTE_TYPE, JSON.stringify(patch), routeId, `${QA_PREFIX}%`],
      )) as unknown as { rows: Array<{ properties: Record<string, unknown> }> };
      properties = patched.rows[0]?.properties ?? null;
    }
    const evaluated = await runRwandaPindoAutomationOnce(new Date());
    const audit = (await query(
      `SELECT outcome, reason, service_identity, action_execution_id, created_at
         FROM rwanda_pindo_automation_audit
        WHERE route_id = $1
        ORDER BY created_at DESC
        LIMIT 5`,
      [routeId],
    )) as unknown as {
      rows: Array<{
        outcome: string;
        reason: string;
        service_identity: string;
        action_execution_id: string | null;
        created_at: string;
      }>;
    };
    res.json({ evaluated, routeId, properties, audit: audit.rows });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message.slice(0, 500) : "pindo evaluation failed",
    });
  }
}
