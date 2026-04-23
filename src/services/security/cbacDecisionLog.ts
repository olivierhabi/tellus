// ---------------------------------------------------------------------------
// src/services/security/cbacDecisionLog.ts
//
// Persists every CBAC decision to cbac_decision_log (migration 037).
// Write-once by REVOKE at the DB layer. Best-effort on the hot path:
// failure to log a decision MUST NOT block the route, but DOES emit a
// Prometheus counter so operators see sustained logging failure.
//
// Rationale for best-effort: unlike the audit hash chain, CBAC decision
// log is a forensic secondary record. The primary authorization signal
// is the route's 403/200 response itself. Blocking the route on log
// failure would trade a forensic gap for an availability outage. The
// metric tellus_cbac_decision_log_failed_total surfaces the gap.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { incCounter } from "../funnel/metrics";
import type { Decision, PolicyContext, Subject } from "./cbacPolicy";

export async function logCbacDecision(
  subject: Subject,
  decision: Decision,
  context: PolicyContext,
): Promise<void> {
  try {
    await query(
      `INSERT INTO cbac_decision_log (
         subject, subject_kind, resource_kind, resource_id,
         ontology_id, decision, reason, matched_rule,
         source_ip, request_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [
        subject.identifier,
        subject.kind,
        context.resourceKind,
        context.resourceId,
        context.ontologyId ?? null,
        decision.decision,
        decision.reason,
        decision.matchedRule ? JSON.stringify(decision.matchedRule) : null,
        context.sourceIp ?? null,
        context.requestId ?? null,
      ],
    );
  } catch (err) {
    incCounter("tellus_cbac_decision_log_failed_total", {
      reason: err instanceof Error ? err.constructor.name : "unknown",
    });
    // Deliberately do not rethrow. See module-level rationale.
  }
}
