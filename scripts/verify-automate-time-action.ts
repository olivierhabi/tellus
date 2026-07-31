import "dotenv/config";
import crypto from "crypto";
import { pool } from "../src/db";
import {
  activateAutomation,
  createDraft,
  updateDraft,
} from "../src/services/automate/repository";
import {
  runAutomateSchedulerOnce,
  runAutomateWorkerOnce,
} from "../src/services/automate/runtime";

async function main(): Promise<void> {
  const ownerUserId = process.env.AUTOMATE_VERIFY_OWNER_ID;
  if (!ownerUserId) {
    throw new Error("AUTOMATE_VERIFY_OWNER_ID is required.");
  }
  const ontologyId =
    process.env.AUTOMATE_VERIFY_ONTOLOGY_ID ??
    "00000000-0000-0000-0000-000000000001";
  const actionApiName =
    process.env.AUTOMATE_VERIFY_ACTION_API_NAME ?? "createOlivierOrder12";
  const action = await pool.query<{
    action_type_id: string;
    definition_version: number;
    definition_hash: string | null;
  }>(
    `SELECT action_type_id, definition_version, definition_hash
       FROM action_type
      WHERE ontology_id = $1 AND api_name = $2 AND is_enabled = true`,
    [ontologyId, actionApiName],
  );
  if (!action.rows[0]) {
    throw new Error(`Enabled Action Type '${actionApiName}' was not found.`);
  }
  const created = await createDraft({
    tenantId: "default",
    ontologyId,
    actorUserId: ownerUserId,
    securitySnapshot: {
      roles: ["ontology-editor"],
      groups: [],
      markings: [],
      cbac: ["ontology-editor"],
      markingBypass: false,
    },
  });
  const orderId = `automate-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const updated = await updateDraft({
    automationId: created.automationId,
    tenantId: "default",
    actorUserId: ownerUserId,
    expectedRevision: created.draftRevision,
    definition: {
      ...created.draftDefinition,
      name: `Verification Time to Action ${orderId}`,
      condition: {
        type: "time",
        evaluationMode: "scheduled",
        schedule: {
          kind: "cron",
          expression: "* * * * *",
          timezone: "UTC",
          missedRunPolicy: "fire-once",
        },
      },
      effects: [
        {
          id: crypto.randomUUID(),
          name: actionApiName,
          order: 0,
          type: "action",
          actionTypeId: action.rows[0].action_type_id,
          actionApiName,
          definitionVersion: action.rows[0].definition_version,
          definitionHash: action.rows[0].definition_hash,
          parameters: {
            orderId: { kind: "constant", value: orderId },
          },
          retry: {
            enabled: true,
            strategy: "constant",
            maxAttempts: 2,
            delaySeconds: 1,
            multiplier: 2,
            maxDelaySeconds: 10,
            jitter: { kind: "none" },
            retryAllFailures: false,
          },
        },
      ],
    },
  });
  const activated = await activateAutomation({
    automationId: created.automationId,
    tenantId: "default",
    actorUserId: ownerUserId,
    expectedRevision: updated.draftRevision,
    idempotencyKey: crypto.randomUUID(),
  });
  await pool.query(
    "UPDATE automation SET next_run_at = now() - interval '1 second' WHERE automation_id = $1",
    [activated.automationId],
  );
  const scheduled = await runAutomateSchedulerOnce(new Date(), 1);
  const executed = await runAutomateWorkerOnce({
    workerId: `manual-verification:${process.pid}`,
    limit: 1,
  });
  const history = await pool.query(
    `SELECT t.trigger_event_id, t.status AS trigger_status,
            e.effect_execution_id, e.status AS effect_status,
            e.attempt_count, e.output, e.error_code, e.error_message
       FROM automation_trigger_event t
       JOIN automation_effect_execution e USING (trigger_event_id)
      WHERE t.automation_id = $1
      ORDER BY t.created_at DESC`,
    [activated.automationId],
  );
  console.log(
    JSON.stringify(
      {
        automationId: activated.automationId,
        automationRid: activated.rid,
        version: activated.currentVersion,
        orderId,
        schedulerCreated: scheduled,
        workerExecuted: executed,
        history: history.rows,
      },
      null,
      2,
    ),
  );
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
