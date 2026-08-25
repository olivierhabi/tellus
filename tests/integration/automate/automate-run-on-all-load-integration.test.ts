// ---------------------------------------------------------------------------
// Run-on-all large-set load verification.
//
// Creates a dedicated object type with 2,500 instances, indexes them
// through the production OpenSearch sync pipeline (which stamps the
// `__ontology` and `_security` fields the OSS v2 read path requires),
// activates a run-on-all automation over the full base object set, and
// drives the real scheduled condition evaluator. Verifies that
// point-in-time cursor pagination and bounded batches:
//   - examine every object exactly once across pages,
//   - create one deduplicated trigger event per object,
//   - execute exactly one notification effect per object,
//   - and that a repeated evaluation key deduplicates cleanly.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../../src/db";
import {
  activateAutomation,
  createDraft,
  updateDraft,
} from "../../../src/services/automate/repository";
import {
  claimAutomateEffects,
  executeClaimedEffect,
} from "../../../src/services/automate/runtime";
import { runAutomateConditionEvaluatorOnce } from "../../../src/services/automate/conditionRuntime";
import type { AutomationDraft } from "../../../src/services/automate/contracts";
import { deriveMainBranchId } from "../../../src/services/branchContext";
import { getKeycloakAdminService } from "../../../src/services/keycloakAdminService";
import { syncObjectInstancesToOpenSearch } from "../../../src/services/opensearch/syncFromInstances";
import { deleteIndex } from "../../../src/services/opensearch/indexLifecycleManager";

const tenantId = "automate-run-on-all-load";
// The evaluator refreshes the owner's security snapshot through the real
// Keycloak admin service, so the owner must be a provisioned realm user
// (cypress-admin is bootstrapped by scripts/bootstrap-keycloak.sh and holds
// the tellus-superadmin realm role for runtime marking bypass). Realm
// bootstraps hand out FRESH UUIDs, so the id is resolved at setup — it
// was once hard-coded to the dev realm's cypress-admin UUID and every
// fresh CI realm failed with `Keycloak resource not found`.
let actorUserId = "";
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const OBJECT_TYPE = `AutomateLoad${suffix}`;
const OBJECT_COUNT = 2_500;
const BATCH_SIZE = 250;

let ontologyId: string;
let automationId: string;

// The dev server (when running) executes effects through the same
// worker path, so this test must not assume it is the sole executor:
// it claims what it can and waits for the database to reach the
// terminal state, whoever executed each effect.
async function drainEffectsUntilSettled(
  expected: number,
  timeoutMs = 300_000,
): Promise<{ executed: number; settled: number }> {
  const deadline = Date.now() + timeoutMs;
  let executed = 0;
  for (let round = 0; Date.now() < deadline; round += 1) {
    const claimed = await claimAutomateEffects({
      workerId: `load-worker-${round % 4}`,
      limit: 64,
    });
    // Bounded execution concurrency: each execution holds pool
    // connections, and an unbounded fan-out starves the shared pg
    // pool (dev server + suite), turning into exhausted retries.
    const CONCURRENCY = 8;
    for (let i = 0; i < claimed.length; i += CONCURRENCY) {
      await Promise.all(
        claimed.slice(i, i + CONCURRENCY).map(async (effect) => {
          await executeClaimedEffect(effect, `load-worker-${round % 4}`);
          executed += 1;
        }),
      );
    }
    const pending = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM automation_effect_execution e
         JOIN automation_trigger_event t USING (trigger_event_id)
        WHERE t.automation_id = $1
          AND e.status IN ('pending','retrying','claimed','running')`,
      [automationId],
    );
    const unsettled = Number(pending.rows[0].count);
    if (unsettled === 0) {
      return { executed, settled: expected };
    }
    if (claimed.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `Effect drain did not settle ${expected} effects within ${timeoutMs}ms.`,
  );
}

beforeAll(async () => {
  const admins = await getKeycloakAdminService().listUsers({
    search: "cypress-admin@tellus.local",
    max: 5,
  });
  const admin = admins.find((u) => u.email === "cypress-admin@tellus.local" || u.username === "cypress-admin@tellus.local");
  if (!admin) {
    throw new Error(
      "cypress-admin@tellus.local not provisioned in the lane Keycloak realm",
    );
  }
  actorUserId = admin.id;

  const ontology = await pool.query<{ ontology_id: string }>(
    "SELECT ontology_id FROM ontology ORDER BY created_at LIMIT 1",
  );
  if (!ontology.rows[0]) {
    throw new Error("Run-on-all load test requires one migrated ontology.");
  }
  ontologyId = ontology.rows[0].ontology_id;

  const objectTypeId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO object_type (
       object_type_id, ontology_id, api_name, display_name,
       status, version, visibility
     ) VALUES ($1,$2,$3,$4,'active',1,'normal')`,
    [objectTypeId, ontologyId, OBJECT_TYPE, OBJECT_TYPE],
  );
  // The production index mapping generator requires at least one
  // registered property per object type, and one of them must be the
  // object type's primary key property.
  const pkPropertyId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO property (
       property_id, object_type_id, api_name, display_name, base_type, ordinal
     ) VALUES ($1,$2,'id','ID','string',0)`,
    [pkPropertyId, objectTypeId],
  );
  await pool.query(
    `INSERT INTO property (
       object_type_id, api_name, display_name, base_type, ordinal
     ) VALUES ($1,'name','Name','string',1)`,
    [objectTypeId],
  );
  await pool.query(
    `UPDATE object_type SET primary_key_property_id = $1
      WHERE object_type_id = $2`,
    [pkPropertyId, objectTypeId],
  );

  // Bulk-insert the fixture objects in 500-row batches. Migration 041
  // made branch_id part of the PK; non-branch-aware fixtures belong to
  // the ontology's canonical main branch.
  const branchId = deriveMainBranchId(ontologyId);
  for (let offset = 0; offset < OBJECT_COUNT; offset += 500) {
    const values: string[] = [];
    const params: unknown[] = [ontologyId, OBJECT_TYPE, branchId];
    for (let i = 0; i < 500 && offset + i < OBJECT_COUNT; i += 1) {
      const n = offset + i;
      params.push(
        `load-${n}`,
        JSON.stringify({ id: `load-${n}`, name: `Load ${n}`, n }),
      );
      const idx = params.length - 1;
      values.push(`($1,$3,$2,$${idx},$${idx + 1}::jsonb)`);
    }
    await pool.query(
      `INSERT INTO object_instances (
         ontology_id, branch_id, object_type_api_name, primary_key, properties
       ) VALUES ${values.join(",")}`,
      params,
    );
  }

  // Index the fixture through the production sync pipeline so the OSS v2
  // read path (PIT snapshot + `__ontology` term + `_security` filter)
  // sees the objects exactly as it sees any platform-indexed set. A
  // concurrently running dev server can win the create-index race for
  // the fresh object type; clear any such shell and tolerate the race.
  await deleteIndex(OBJECT_TYPE).catch(() => undefined);
  let sync: { rowsIndexed: number };
  try {
    sync = await syncObjectInstancesToOpenSearch(OBJECT_TYPE, ontologyId);
  } catch (error) {
    if (!String((error as Error).message).includes("already exists")) {
      throw error;
    }
    sync = await syncObjectInstancesToOpenSearch(OBJECT_TYPE, ontologyId);
  }
  if (sync.rowsIndexed !== OBJECT_COUNT) {
    throw new Error(
      `Fixture sync indexed ${sync.rowsIndexed}, expected ${OBJECT_COUNT}.`,
    );
  }
}, 300_000);

afterAll(async () => {
  if (automationId) {
    await pool
      .query(
        `DELETE FROM notification_inbox WHERE execution_id IN (
           SELECT effect_execution_id::text
             FROM automation_effect_execution e
             JOIN automation_trigger_event t USING (trigger_event_id)
            WHERE t.automation_id = $1
         )`,
        [automationId],
      )
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM automation_trigger_event WHERE automation_id = $1`, [
        automationId,
      ])
      .catch(() => undefined);
    await pool
      .query(
        `DELETE FROM automation_condition_evaluation WHERE automation_id = $1`,
        [automationId],
      )
      .catch(() => undefined);
    await pool
      .query(
        `DELETE FROM automation_object_membership WHERE automation_id = $1`,
        [automationId],
      )
      .catch(() => undefined);
    await pool
      .query(`DELETE FROM automation WHERE automation_id = $1`, [
        automationId,
      ])
      .catch(() => undefined);
  }
  await deleteIndex(OBJECT_TYPE).catch(() => undefined);
  await pool
    .query(
      `DELETE FROM object_instances
        WHERE ontology_id = $1 AND object_type_api_name = $2`,
      [ontologyId, OBJECT_TYPE],
    )
    .catch(() => undefined);
  await pool
    .query(
      `DELETE FROM object_type
        WHERE ontology_id = $1 AND api_name = $2`,
      [ontologyId, OBJECT_TYPE],
    )
    .catch(() => undefined);
  // Properties cascade with the object type row.
  await pool.end();
});

describe("Run-on-all large-set load", () => {
  it(
    "paginates the full indexed object set with bounded batches, one trigger and effect per object, and deduplicates re-evaluation",
    async () => {
      const created = await createDraft({
        tenantId,
        ontologyId,
        actorUserId,
        // Real clearance (see the marking-constrained scan note in this
        // repo's other automate suites): an empty markings list is
        // fail-closed zero-hit against F-03 PUBLIC-default documents.
        securitySnapshot: {
          roles: ["tellus-superadmin"],
          markings: ["PUBLIC", "CONFIDENTIAL", "SECRET", "TOP_SECRET"],
          cbac: [],
          organizations: [],
          markingBypass: true,
        },
      });
      automationId = created.automationId;

      const definition: AutomationDraft = {
        ...created.draftDefinition,
        name: `Run-on-all load ${crypto.randomUUID().slice(0, 8)}`,
        // Parallel fan-out with no trigger queueing: every matched
        // object's effect is claimable immediately, which is what this
        // load test exercises. The default draft queues trigger events,
        // serializing execution one trigger at a time.
        executionStrategy: { mode: "parallel", queueTriggerEvents: false },
        condition: {
          type: "run-on-all",
          evaluationMode: "scheduled",
          objectTypeApiName: OBJECT_TYPE,
          objectSet: { type: "base", objectType: OBJECT_TYPE },
          schedule: {
            // Far-future cron: the test enqueues its evaluation row
            // manually; a running dev server's scheduler must not
            // enqueue extra evaluations for this automation mid-test.
            kind: "cron",
            expression: "0 0 1 1 *",
            timezone: "UTC",
            missedRunPolicy: "fire-once",
          },
          monitoredProperties: [],
          alsoTriggerWhenAdded: false,
          alsoTriggerWhenRemoved: false,
          batchSize: BATCH_SIZE,
        },
        effects: [
          {
            id: crypto.randomUUID(),
            name: "Load notification",
            order: 0,
            type: "notification",
            recipients: {
              static: [
                {
                  kind: "user",
                  id: actorUserId,
                  displayName: "Run-on-all Load Owner",
                },
              ],
              dynamic: [],
            },
            channels: ["in_app"],
            content: {
              kind: "plain",
              heading: "Load trigger",
              message: "Run-on-all fired.",
              useSystemFallback: false,
            },
            grouping: { mode: "all", propertyApiNames: [] },
            locale: "en-US",
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
            eventRetryLimit: 2,
          },
        ],
      };

      const updated = await updateDraft({
        automationId,
        tenantId,
        actorUserId,
        expectedRevision: created.draftRevision,
        definition,
      });
      await activateAutomation({
        automationId,
        tenantId,
        actorUserId,
        expectedRevision: updated.draftRevision,
        idempotencyKey: crypto.randomUUID(),
      });

      // Enqueue one scheduled evaluation exactly as the production scheduler
      // would for a non-time condition.
      await pool.query(
        `INSERT INTO automation_condition_evaluation (
           automation_id, automation_version, evaluation_key, scheduled_for
         ) VALUES ($1,1,$2,now())
         ON CONFLICT (evaluation_key) DO NOTHING`,
        [automationId, `scheduled-evaluation:${automationId}:1:load-1`],
      );

      // Drive the real evaluator worker; it claims the row, paginates with
      // the PIT cursor, and persists examined/matched counts per page. One
      // pass processes every page of its claimed row; loop defensively for
      // lease/retry edge cases and surface any durable error.
      const startedAt = Date.now();
      let evaluationRows: Array<{
        status: string;
        examined_count: string;
        matched_count: string;
        cursor: string | null;
        error_code: string | null;
        error_message: string | null;
      }> = [];
      for (let pass = 0; pass < 5; pass += 1) {
        await runAutomateConditionEvaluatorOnce({ workerId: "load-eval-1" });
        const result = await pool.query<{
          status: string;
          examined_count: string;
          matched_count: string;
          cursor: string | null;
          error_code: string | null;
          error_message: string | null;
        }>(
          `SELECT status, examined_count, matched_count, cursor,
                  error_code, error_message
             FROM automation_condition_evaluation
            WHERE automation_id = $1`,
          [automationId],
        );
        evaluationRows = result.rows;
        if (
          evaluationRows[0]?.status === "succeeded" ||
          evaluationRows[0]?.status === "failed"
        ) {
          break;
        }
      }
      const elapsedMs = Date.now() - startedAt;
      const evaluation = { rows: evaluationRows };

      expect(evaluation.rows).toHaveLength(1);
      expect(
        evaluation.rows[0].status,
        `evaluation error: ${evaluation.rows[0].error_code} ${evaluation.rows[0].error_message}`,
      ).toBe("succeeded");
      expect(Number(evaluation.rows[0].examined_count)).toBe(OBJECT_COUNT);
      expect(Number(evaluation.rows[0].matched_count)).toBe(OBJECT_COUNT);
      // Final page closes the cursor.
      expect(evaluation.rows[0].cursor).toBeNull();

      const triggers = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM automation_trigger_event
          WHERE automation_id = $1 AND trigger_type = 'run-on-all'`,
        [automationId],
      );
      expect(Number(triggers.rows[0].count)).toBe(OBJECT_COUNT);

      // Membership snapshot recorded every object once.
      const membership = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM automation_object_membership
          WHERE automation_id = $1 AND present = true`,
        [automationId],
      );
      expect(Number(membership.rows[0].count)).toBe(OBJECT_COUNT);

      // Execute the full effect fan-out through the production worker
      // path. A running dev server executes effects through the same
      // claim path, so the test asserts the terminal state rather than
      // which process executed each effect.
      const drain = await drainEffectsUntilSettled(OBJECT_COUNT);

      const effects = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM automation_effect_execution e
           JOIN automation_trigger_event t USING (trigger_event_id)
          WHERE t.automation_id = $1 AND e.status = 'succeeded'`,
        [automationId],
      );
      const breakdown = await pool.query<{
        status: string;
        count: string;
        error_code: string | null;
      }>(
        `SELECT e.status, count(*)::text AS count,
                max(e.error_code) AS error_code
           FROM automation_effect_execution e
           JOIN automation_trigger_event t USING (trigger_event_id)
          WHERE t.automation_id = $1
          GROUP BY e.status`,
        [automationId],
      );
      expect(
        Number(effects.rows[0].count),
        `effect status breakdown: ${JSON.stringify(breakdown.rows)}`,
      ).toBe(OBJECT_COUNT);

      // One in-app notification per object, scoped to this automation's
      // executions (the recipient is shared with other suites).
      const inbox = await pool.query<{ count: string }>(
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
      expect(Number(inbox.rows[0].count)).toBe(OBJECT_COUNT);

      // A repeated evaluation key must not double-insert or re-fire.
      await pool.query(
        `INSERT INTO automation_condition_evaluation (
           automation_id, automation_version, evaluation_key, scheduled_for
         ) VALUES ($1,1,$2,now())
         ON CONFLICT (evaluation_key) DO NOTHING`,
        [automationId, `scheduled-evaluation:${automationId}:1:load-1`],
      );
      const claimedDuplicate = await runAutomateConditionEvaluatorOnce({
        workerId: "load-eval-1",
      });
      expect(claimedDuplicate).toBe(0);

      console.log(
        `[run-on-all load] ${OBJECT_COUNT} objects, batch=${BATCH_SIZE}, ` +
          `evaluation=${elapsedMs}ms, executed-by-test=${drain.executed}`,
      );
    },
    600_000,
  );
});
