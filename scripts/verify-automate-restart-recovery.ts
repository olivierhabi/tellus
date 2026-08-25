import "dotenv/config";
import crypto from "crypto";
import { pool } from "../src/db";
import {
  activateAutomation,
  createDraft,
  transitionAutomation,
  updateDraft,
} from "../src/services/automate/repository";
import { runAutomateSchedulerOnce } from "../src/services/automate/runtime";
import type { AutomationDraft } from "../src/services/automate/contracts";

// ---------------------------------------------------------------------------
// Manual verification driver for spec §25 "Restart and recovery" and
// "Retry and fallback" items 3-4. The companion shell script
// (verify-automate-restart-recovery.sh) orchestrates real API-server
// process kills between these steps:
//
//   setup <email|inapp> <name>  create + activate a time automation whose
//                               notification effect either fails retryably
//                               (email channel against an unroutable
//                               EMAIL_PROVIDER_URL) or succeeds (in_app),
//                               then force its schedule due.
//   schedule                    run one real scheduler pass (used while the
//                               API server runs with the runtime disabled).
//   state <automationId>        dump trigger/effect/attempt/inbox state.
//   craft-crash <automationId>  mark the latest pending effect as claimed by
//                               a dead worker with a future lease — the exact
//                               durable state a terminated worker leaves.
//   cleanup <automationId>      archive the automation.
// ---------------------------------------------------------------------------

const OWNER_USER_ID = "53cf9bcf-4c20-4aed-83f4-3c7e405453b4"; // cypress-admin
const TENANT_ID = "default";
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

function notificationDefinition(
  name: string,
  channel: "email" | "in_app",
): (
  base: AutomationDraft,
) => AutomationDraft {
  return (base) => ({
    ...base,
    name,
    condition: {
      type: "time",
      evaluationMode: "scheduled",
      schedule: {
        // Far-future cron: only the forced next_run_at fires this.
        kind: "cron",
        expression: "0 0 1 1 *",
        timezone: "UTC",
        missedRunPolicy: "fire-once",
      },
    },
    effects: [
      {
        id: crypto.randomUUID(),
        name: `${name} notification`,
        order: 0,
        type: "notification",
        recipients: {
          static: [
            {
              kind: "user",
              id: OWNER_USER_ID,
              displayName: "Cypress Admin",
            },
          ],
          dynamic: [],
        },
        channels: [channel],
        content: {
          kind: "plain",
          heading: name,
          message: "Restart/recovery verification delivery.",
          useSystemFallback: false,
        },
        grouping: { mode: "all", propertyApiNames: [] },
        locale: "en-US",
        retry: {
          enabled: true,
          strategy: "constant",
          maxAttempts: 3,
          delaySeconds: 20,
          multiplier: 2,
          maxDelaySeconds: 60,
          jitter: { kind: "none" },
          retryAllFailures: false,
        },
      },
    ],
  });
}

async function setup(channel: "email" | "in_app", name: string) {
  const created = await createDraft({
    tenantId: TENANT_ID,
    ontologyId: ONTOLOGY_ID,
    actorUserId: OWNER_USER_ID,
    securitySnapshot: {
      roles: ["tellus-superadmin"],
      markings: [],
      cbac: [],
      organizations: [],
      markingBypass: true,
    },
  });
  const updated = await updateDraft({
    automationId: created.automationId,
    tenantId: TENANT_ID,
    actorUserId: OWNER_USER_ID,
    expectedRevision: created.draftRevision,
    definition: notificationDefinition(name, channel)(
      created.draftDefinition,
    ),
  });
  const activated = await activateAutomation({
    automationId: created.automationId,
    tenantId: TENANT_ID,
    actorUserId: OWNER_USER_ID,
    expectedRevision: updated.draftRevision,
    idempotencyKey: crypto.randomUUID(),
  });
  await pool.query(
    "UPDATE automation SET next_run_at = now() - interval '1 second' WHERE automation_id = $1",
    [activated.automationId],
  );
  console.log(JSON.stringify({ automationId: activated.automationId }));
}

async function schedule() {
  const created = await runAutomateSchedulerOnce(new Date(), 10);
  console.log(JSON.stringify({ triggerEventsCreated: created }));
}

async function state(automationId: string) {
  const automation = await pool.query(
    `SELECT status, current_version, next_run_at FROM automation WHERE automation_id = $1`,
    [automationId],
  );
  const triggers = await pool.query(
    `SELECT trigger_event_id, trigger_type, status, created_at, completed_at
       FROM automation_trigger_event WHERE automation_id = $1
       ORDER BY created_at`,
    [automationId],
  );
  const effects = await pool.query(
    `SELECT e.effect_execution_id, e.status, e.attempt_count, e.max_attempts,
            e.next_attempt_at, e.lease_owner, e.lease_expires_at,
            e.started_at, e.completed_at, e.error_code
       FROM automation_effect_execution e
       JOIN automation_trigger_event t USING (trigger_event_id)
      WHERE t.automation_id = $1
      ORDER BY e.created_at`,
    [automationId],
  );
  const attempts = await pool.query(
    `SELECT a.effect_execution_id, a.attempt_number, a.status, a.retryable,
            a.error_code, a.started_at, a.completed_at, a.next_retry_at
       FROM automation_effect_attempt a
       JOIN automation_effect_execution e USING (effect_execution_id)
       JOIN automation_trigger_event t USING (trigger_event_id)
      WHERE t.automation_id = $1
      ORDER BY a.started_at`,
    [automationId],
  );
  const inbox = await pool.query(
    `SELECT count(*)::text AS count
       FROM notification_inbox
      WHERE execution_id IN (
        SELECT e.effect_execution_id::text
          FROM automation_effect_execution e
          JOIN automation_trigger_event t USING (trigger_event_id)
         WHERE t.automation_id = $1
      )`,
    [automationId],
  );
  console.log(
    JSON.stringify(
      {
        automation: automation.rows[0] ?? null,
        triggers: triggers.rows,
        effects: effects.rows,
        attempts: attempts.rows,
        inboxCount: Number(inbox.rows[0]?.count ?? 0),
      },
      null,
      2,
    ),
  );
}

async function craftCrash(automationId: string, leaseSeconds: number) {
  // A terminated worker leaves exactly this durable state: the effect is
  // claimed, owned by a dead lease owner, with a lease that has not yet
  // expired. Recovery must wait for lease_expires_at before re-claiming.
  const result = await pool.query(
    `UPDATE automation_effect_execution e
        SET status = 'claimed',
            lease_owner = 'dead-worker-manual-verification',
            lease_expires_at = now() + make_interval(secs => $2),
            heartbeat_at = now(),
            started_at = now(),
            updated_at = now()
       FROM automation_trigger_event t
      WHERE e.trigger_event_id = t.trigger_event_id
        AND t.automation_id = $1
        AND e.status = 'pending'
      RETURNING e.effect_execution_id, e.lease_expires_at`,
    [automationId, leaseSeconds],
  );
  if (result.rows.length !== 1) {
    throw new Error(
      `Expected exactly one pending effect to crash-mark, got ${result.rows.length}.`,
    );
  }
  console.log(JSON.stringify({ crashedEffect: result.rows[0] }));
}

async function cleanup(automationId: string) {
  await transitionAutomation({
    automationId,
    tenantId: TENANT_ID,
    actorUserId: OWNER_USER_ID,
    target: "archived",
    reason: "Restart/recovery verification cleanup",
  });
  console.log(JSON.stringify({ archived: automationId }));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "setup":
      await setup(args[0] as "email" | "in_app", args[1]);
      break;
    case "schedule":
      await schedule();
      break;
    case "state":
      await state(args[0]);
      break;
    case "craft-crash":
      await craftCrash(args[0], Number(args[1] ?? 25));
      break;
    case "cleanup":
      await cleanup(args[0]);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
