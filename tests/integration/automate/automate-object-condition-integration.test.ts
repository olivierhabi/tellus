// ---------------------------------------------------------------------------
// Automate object-set condition filter (objectCondition) + membership
// initialization integration tests.
//
// Proves the whole vertical slice against a real PostgreSQL + OpenSearch:
//
//   condition.objectCondition (canonical SearchJsonQueryV2)
//     -> effectiveObjectSet = objectSet AND objectCondition
//     -> scheduled evaluation queries the FILTERED set
//     -> membership baseline WITHOUT an added-storm for pre-existing objects
//     -> new matching object emits exactly one trigger
//     -> new nonmatching object emits no trigger
//     -> duplicate re-evaluation emits no duplicate trigger
//     -> identical-condition version bump copies membership forward (no replay)
//     -> changed-condition version bump rebaselines (no storm)
//
// A dedicated object type is seeded + indexed through the PRODUCTION
// OpenSearch sync pipeline (the same path the run-on-all load suite uses)
// so the OSS v2 read path sees the fixture exactly like any platform set.
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
import { conditionFingerprint } from "../../../src/services/automate/objectCondition";
import { getKeycloakAdminService } from "../../../src/services/keycloakAdminService";
import type { AutomationDraft } from "../../../src/services/automate/contracts";
import { deriveMainBranchId } from "../../../src/services/branchContext";
import { syncObjectInstancesToOpenSearch } from "../../../src/services/opensearch/syncFromInstances";
import { deleteIndex } from "../../../src/services/opensearch/indexLifecycleManager";

const tenantId = "automate-object-condition";
// The evaluator refreshes the owner's security snapshot through the real
// Keycloak admin service; cypress-admin is a provisioned realm user with
// the tellus-superadmin role (runtime marking bypass). Realm bootstraps
// hand out FRESH UUIDs, so the id is resolved at setup — the previously
// hard-coded dev-realm UUID failed CI with `Keycloak resource not found`.
let actorUserId = "";
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const OBJECT_TYPE = `AutomateFilter${suffix}`;
const MATCH_TIN = `match-${suffix}`;
const OTHER_TIN = `other-${suffix}`;

let ontologyId: string;
let automationId: string;

// The snapshot MUST reflect the owner's REAL Keycloak clearance. The
    // evaluator refreshes the stored snapshot at runtime
    // (currentOwnerSecuritySnapshot spreads it, keeping `markings`), and a
    // marking-constrained scan with `markings: []` is fail-closed zero-hit —
    // every indexed document carries `_security.markings: ['PUBLIC']`
    // (F-03), which an empty terms clause can never match.
    // cypress-admin holds PUBLIC/CONFIDENTIAL/SECRET/TOP_SECRET via the
    // realm's `marking:*` role assignments (bootstrap-keycloak.sh).
    const securitySnapshot = {
  roles: ["tellus-superadmin"],
  markings: ["PUBLIC", "CONFIDENTIAL", "SECRET", "TOP_SECRET"],
  cbac: [],
  organizations: [],
  markingBypass: true,
};

async function seedObject(id: string, name: string, tin: string) {
  const branchId = deriveMainBranchId(ontologyId);
  await pool.query(
    `INSERT INTO object_instances (
       ontology_id, branch_id, object_type_api_name, primary_key, properties
     ) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [ontologyId, branchId, OBJECT_TYPE, id, JSON.stringify({ id, name, tin })],
  );
  await syncObjectInstancesToOpenSearch(OBJECT_TYPE, ontologyId);
}

async function runEvaluation(workerId: string, maxPasses = 5) {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    await runAutomateConditionEvaluatorOnce({ workerId });
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM automation_condition_evaluation
        WHERE automation_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [automationId],
    );
    const status = row.rows[0]?.status;
    if (status === "succeeded" || status === "failed") return status;
  }
  return "running";
}

async function enqueueEvaluation(key: string) {
  await pool.query(
    `INSERT INTO automation_condition_evaluation (
       automation_id, automation_version, evaluation_key, scheduled_for
     ) VALUES ($1,(SELECT current_version FROM automation WHERE automation_id = $2),$3,now())
     ON CONFLICT (evaluation_key) DO NOTHING`,
    [automationId, automationId, key],
  );
}

async function countObjectAddedTriggers(): Promise<number> {
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM automation_trigger_event
      WHERE automation_id = $1 AND trigger_type = 'object-added'`,
    [automationId],
  );
  return Number(r.rows[0].count);
}

async function membershipCount(): Promise<number> {
  // Scope to the automation's CURRENT version — membership is keyed
  // per-version, and a copy-forward version bump intentionally duplicates
  // the rows across the old and new versions.
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM automation_object_membership
      WHERE automation_id = $1
        AND automation_version = (
          SELECT current_version FROM automation WHERE automation_id = $1
        )
        AND present = true`,
    [automationId],
  );
  return Number(r.rows[0].count);
}

async function conditionState(): Promise<{
  initialized?: boolean;
  status?: string;
  condition_fingerprint?: string;
}> {
  const r = await pool.query<{ state: Record<string, unknown> }>(
    `SELECT state FROM automation_condition_state
      WHERE automation_id = $1
      ORDER BY automation_version DESC LIMIT 1`,
    [automationId],
  );
  return r.rows[0]?.state ?? {};
}

async function drainEffects(expected: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (let round = 0; Date.now() < deadline; round += 1) {
    const claimed = await claimAutomateEffects({
      workerId: `filter-worker-${round % 4}`,
      limit: 16,
    });
    for (const effect of claimed) {
      await executeClaimedEffect(effect, `filter-worker-${round % 4}`);
    }
    const pending = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM automation_effect_execution e
        JOIN automation_trigger_event t USING (trigger_event_id)
        WHERE t.automation_id = $1
          AND e.status IN ('pending','retrying','claimed','running')`,
      [automationId],
    );
    const done = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM automation_effect_execution e
        JOIN automation_trigger_event t USING (trigger_event_id)
        WHERE t.automation_id = $1 AND e.status = 'succeeded'`,
      [automationId],
    );
    if (Number(pending.rows[0].count) === 0 && Number(done.rows[0].count) === expected) {
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function objectAddedDefinition(filterValue: string | null): (base: AutomationDraft) => AutomationDraft {
  return (base) => ({
    ...base,
    name: `Object condition ${crypto.randomUUID().slice(0, 8)}`,
    executionStrategy: { mode: "parallel", queueTriggerEvents: false },
    condition: {
      type: "objects-added",
      evaluationMode: "scheduled",
      objectTypeApiName: OBJECT_TYPE,
      objectSet: { type: "base", objectType: OBJECT_TYPE },
      ...(filterValue != null
        ? { objectCondition: { type: "eq", field: "tin", value: filterValue } }
        : {}),
      // Far-future cron; the test enqueues evaluations manually so a running
      // dev server's scheduler cannot enqueue extra evaluations mid-test.
      schedule: {
        kind: "cron",
        expression: "0 0 1 1 *",
        timezone: "UTC",
        missedRunPolicy: "fire-once",
      },
      monitoredProperties: [],
      alsoTriggerWhenAdded: false,
      alsoTriggerWhenRemoved: false,
      batchSize: 10,
    },
    effects: [
      {
        id: crypto.randomUUID(),
        name: "Notify owner",
        order: 0,
        type: "notification",
        recipients: {
          static: [{ kind: "user", id: actorUserId, displayName: "Owner" }],
          dynamic: [],
        },
        channels: ["in_app"],
        content: {
          kind: "plain",
          heading: "Object added",
          message: "A matching object entered the set.",
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
  });
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
  if (!ontology.rows[0]) throw new Error("Requires one migrated ontology.");
  ontologyId = ontology.rows[0].ontology_id;

  const objectTypeId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO object_type (
       object_type_id, ontology_id, api_name, display_name,
       status, version, visibility
     ) VALUES ($1,$2,$3,$4,'active',1,'normal')`,
    [objectTypeId, ontologyId, OBJECT_TYPE, OBJECT_TYPE],
  );
  const pkId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO property (property_id, object_type_id, api_name, display_name, base_type, ordinal)
     VALUES ($1,$2,'id','ID','string',0)`,
    [pkId, objectTypeId],
  );
  await pool.query(
    `INSERT INTO property (object_type_id, api_name, display_name, base_type, ordinal)
     VALUES ($1,'name','Name','string',1),($1,'tin','TIN','string',2)`,
    [objectTypeId],
  );
  await pool.query(
    `UPDATE object_type SET primary_key_property_id = $1 WHERE object_type_id = $2`,
    [pkId, objectTypeId],
  );

  // Pre-existing objects: two matching, one nonmatching.
  await seedObject(`${suffix}-a`, "Match A", MATCH_TIN);
  await seedObject(`${suffix}-b`, "Match B", MATCH_TIN);
  await seedObject(`${suffix}-c`, "Other C", OTHER_TIN);
}, 180_000);

afterAll(async () => {
  if (automationId) {
    await pool
      .query(
        `DELETE FROM notification_inbox WHERE execution_id IN (
           SELECT effect_execution_id::text FROM automation_effect_execution e
           JOIN automation_trigger_event t USING (trigger_event_id)
            WHERE t.automation_id = $1)`,
        [automationId],
      )
      .catch(() => undefined);
    for (const table of [
      "automation_effect_attempt",
      "automation_effect_execution",
      "automation_trigger_event",
      "automation_object_membership",
      "automation_condition_evaluation",
      "automation_condition_state",
      "automation_dependency",
      "automation_version",
      "automation_idempotency",
      "automation_audit_event",
    ]) {
      await pool
        .query(`DELETE FROM ${table} WHERE automation_id = $1`, [automationId])
        .catch(() => undefined);
    }
    await pool
      .query(`DELETE FROM automation WHERE automation_id = $1`, [automationId])
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
    .query(`DELETE FROM object_type WHERE ontology_id = $1 AND api_name = $2`, [
      ontologyId,
      OBJECT_TYPE,
    ])
    .catch(() => undefined);
  await pool.end();
});

describe("Object-set condition filter + membership initialization", () => {
  it("filters the monitored set, baselines without a storm, and diffs deterministically", async () => {
    // --- activate with the property filter ---
    const created = await createDraft({
      tenantId,
      ontologyId,
      actorUserId,
      securitySnapshot,
    });
    automationId = created.automationId;
    const definition = objectAddedDefinition(MATCH_TIN)(created.draftDefinition);
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

    // The activation enqueued a scheduled-baseline; run it. It scans the
    // FILTERED set (match only) and suppresses triggers for pre-existing
    // objects, then flips initialized -> ready.
    const baselineStatus = await runEvaluation("filter-baseline-1");
    expect(baselineStatus).toBe("succeeded");

    // No trigger was emitted for the two pre-existing matching objects.
    expect(await countObjectAddedTriggers()).toBe(0);
    // Membership baseline contains ONLY the two matching objects (the
    // nonmatching object is excluded by the property filter).
    expect(await membershipCount()).toBe(2);
    // The condition is now initialized/ready with a recorded fingerprint.
    const state = await conditionState();
    expect(state.initialized).toBe(true);
    expect(state.condition_fingerprint).toEqual(
      conditionFingerprint(definition.condition),
    );

    // --- a new matching object emits exactly one trigger + one effect ---
    await seedObject(`${suffix}-d`, "Match D", MATCH_TIN);
    await enqueueEvaluation(`scheduled-evaluation:${automationId}:1:add-d`);
    expect(await runEvaluation("filter-eval-add-d")).toBe("succeeded");
    expect(await countObjectAddedTriggers()).toBe(1);
    expect(await membershipCount()).toBe(3);
    // Exactly one durable side effect (one notification effect execution).
    await drainEffects(1);
    const effects = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM automation_effect_execution e
        JOIN automation_trigger_event t USING (trigger_event_id)
        WHERE t.automation_id = $1 AND e.status = 'succeeded'`,
      [automationId],
    );
    expect(Number(effects.rows[0].count)).toBe(1);

    // --- a new nonmatching object emits no trigger ---
    await seedObject(`${suffix}-e`, "Other E", OTHER_TIN);
    await enqueueEvaluation(`scheduled-evaluation:${automationId}:1:add-e`);
    expect(await runEvaluation("filter-eval-add-e")).toBe("succeeded");
    expect(await countObjectAddedTriggers()).toBe(1); // unchanged
    expect(await membershipCount()).toBe(3);

    // --- duplicate re-evaluation emits no duplicate trigger ---
    await enqueueEvaluation(`scheduled-evaluation:${automationId}:1:add-d-redeliver`);
    expect(await runEvaluation("filter-eval-redeliver")).toBe("succeeded");
    expect(await countObjectAddedTriggers()).toBe(1); // unchanged

    // --- identical-condition version bump copies membership forward ---
    const membershipBeforeV2 = await membershipCount();
    const renamed = {
      ...definition,
      name: `Object condition renamed ${crypto.randomUUID().slice(0, 8)}`,
    };
    const updatedV2 = await updateDraft({
      automationId,
      tenantId,
      actorUserId,
      expectedRevision: updated.draftRevision,
      definition: renamed,
    });
    await activateAutomation({
      automationId,
      tenantId,
      actorUserId,
      expectedRevision: updatedV2.draftRevision,
      idempotencyKey: crypto.randomUUID(),
    });
    const stateV2 = await conditionState();
    expect(stateV2.initialized).toBe(true); // copied forward, no rebaseline
    expect(stateV2.condition_fingerprint).toBe(state.condition_fingerprint);
    expect(await membershipCount()).toBe(membershipBeforeV2); // preserved
    expect(await countObjectAddedTriggers()).toBe(1); // no replay

    // --- changed-condition version bump rebaselines without a storm ---
    const changed = objectAddedDefinition(OTHER_TIN)({
      ...definition,
    } as AutomationDraft);
    const updatedV3 = await updateDraft({
      automationId,
      tenantId,
      actorUserId,
      expectedRevision: updatedV2.draftRevision,
      definition: changed,
    });
    await activateAutomation({
      automationId,
      tenantId,
      actorUserId,
      expectedRevision: updatedV3.draftRevision,
      idempotencyKey: crypto.randomUUID(),
    });
    const stateV3 = await conditionState();
    expect(stateV3.initialized).not.toBe(true); // rebaseline pending
    expect(stateV3.condition_fingerprint).not.toBe(state.condition_fingerprint);
    // Run the rebaseline: the set is now {C, E} (both tin=other) and no
    // pre-existing object may fire an objects-added trigger.
    expect(await runEvaluation("filter-baseline-v3")).toBe("succeeded");
    expect(await countObjectAddedTriggers()).toBe(1); // still no storm
    expect(await membershipCount()).toBe(2); // C and E baseline
    expect((await conditionState()).initialized).toBe(true);
  }, 180_000);
});
