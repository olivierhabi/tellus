import { query } from "../../db";

export interface OssV2AuditInput {
  eventType:
    | "object_load"
    | "restricted_property_attempt"
    | "transaction_read"
    | "scenario_read"
    | "temporary_object_set_access"
    | "subscription_create"
    | "subscription_resume"
    | "action_apply"
    | "security_denied";
  tenantId: string;
  ontologyId?: string | null;
  userId: string;
  branchId?: string | null;
  transactionId?: string | null;
  scenarioRid?: string | null;
  requestId?: string | null;
  outcome: "success" | "denied" | "error";
  /** Metadata only. Never pass property values, credentials, or signed refs. */
  parameters?: Record<string, string | number | boolean | null>;
}
export async function recordOssV2Audit(
  input: OssV2AuditInput,
): Promise<void> {
  await query(
    `INSERT INTO oss_v2_audit_event
       (event_type, tenant_id, ontology_id, user_id, branch_id,
        transaction_id, scenario_rid, request_id, outcome, parameters)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      input.eventType,
      input.tenantId,
      input.ontologyId ?? null,
      input.userId,
      input.branchId ?? null,
      input.transactionId ?? null,
      input.scenarioRid ?? null,
      input.requestId ?? null,
      input.outcome,
      JSON.stringify(input.parameters ?? {}),
    ],
  );
}

/** Auditing is mandatory but must not turn a successful data read into a 500. */
export function recordOssV2AuditBestEffort(
  input: OssV2AuditInput,
): void {
  void recordOssV2Audit(input).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "oss_v2.audit_write_failed",
        eventType: input.eventType,
        requestId: input.requestId ?? null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}
