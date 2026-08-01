import crypto from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../../src/db";
import {
  AutomationServiceError,
  activateAutomation,
  createDraft,
  getExecutionDetails,
  listAutomationAudit,
  listConditionEvaluations,
  listExecutionHistory,
  retryTriggerEvent,
  transitionAutomation,
  updateDraft,
} from "../../../src/services/automate/repository";
import {
  claimAutomateEffects,
  executeClaimedEffect,
  runAutomateSchedulerOnce,
} from "../../../src/services/automate/runtime";
import type { AutomationDraft } from "../../../src/services/automate/contracts";

const tenantId = "automate-integration";
const actorUserId = crypto.randomUUID();
const createdIds: string[] = [];
let ontologyId: string;
let fallbackActionTypeId: string;
const fallbackActionApiName =
  `automateIntegrationFallback${crypto.randomUUID().replaceAll("-", "")}`;

function notificationEffect(maxRetries = 2) {
  return {
    id: crypto.randomUUID(),
    name: "Test notification",
    order: 0,
    type: "notification" as const,
    recipients: {
      static: [
        {
          kind: "user" as const,
          id: actorUserId,
          displayName: "Automate Integration Owner",
        },
      ],
      dynamic: [],
    },
    channels: ["in_app" as const],
    content: {
      kind: "plain" as const,
      heading: "Integration trigger",
      message: "The durable automation fired.",
      useSystemFallback: false,
    },
    grouping: { mode: "all" as const, propertyApiNames: [] },
    locale: "en-US",
    retry: {
      enabled: true,
      strategy: "constant" as const,
      maxAttempts: 2,
      delaySeconds: 1,
      multiplier: 2,
      maxDelaySeconds: 10,
      jitter: { kind: "none" as const },
      retryAllFailures: false,
    },
    eventRetryLimit: maxRetries,
  };
}

async function createConfiguredAutomation(maxEventRetries = 2) {
  const created = await createDraft({
    tenantId,
    ontologyId,
    actorUserId,
    securitySnapshot: {
      roles: ["tellus-superadmin"],
      markings: [],
      cbac: [],
      organizations: [],
      markingBypass: false,
    },
  });
  createdIds.push(created.automationId);
  const updated = await updateDraft({
    automationId: created.automationId,
    tenantId,
    actorUserId,
    expectedRevision: created.draftRevision,
    definition: {
      ...created.draftDefinition,
      name: `Automate integration ${created.automationId}`,
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
      effects: [notificationEffect()],
      settings: {
        ...created.draftDefinition.settings,
        eventRetries: {
          enabled: true,
          maxRetries: maxEventRetries,
          intervalSeconds: 60,
        },
      },
    },
  });
  return { created, updated };
}

async function createActivatedAutomation(
  transform: (definition: AutomationDraft) => AutomationDraft,
) {
  const { created, updated } = await createConfiguredAutomation();
  const transformed = await updateDraft({
    automationId: created.automationId,
    tenantId,
    actorUserId,
    expectedRevision: updated.draftRevision,
    definition: transform(updated.draftDefinition),
  });
  return activateAutomation({
    automationId: created.automationId,
    tenantId,
    actorUserId,
    expectedRevision: transformed.draftRevision,
    idempotencyKey: crypto.randomUUID(),
  });
}

beforeAll(async () => {
  const ontology = await pool.query<{ ontology_id: string }>(
    "SELECT ontology_id FROM ontology ORDER BY created_at LIMIT 1",
  );
  if (!ontology.rows[0]) {
    throw new Error("Automate integration tests require one migrated ontology.");
  }
  ontologyId = ontology.rows[0].ontology_id;
  const fallbackAction = await pool.query<{ action_type_id: string }>(
    `INSERT INTO action_type (
       ontology_id, api_name, display_name, parameters, rules,
       is_enabled, created_by, semantics_version, execution_mode, delete_policy
     ) VALUES (
       $1,$2,'Automate integration fallback','[]','[]',true,$3,
       1,'declarative','legacy_unchecked'
     )
     RETURNING action_type_id`,
    [ontologyId, fallbackActionApiName, actorUserId],
  );
  fallbackActionTypeId = fallbackAction.rows[0].action_type_id;
});

afterEach(async () => {
  // A co-running automate runtime (e.g. `pnpm dev`) may execute this
  // tenant's notification effects for real; drop any inbox rows those
  // executions produced before the trigger rows they reference go away.
  await pool.query(
    `DELETE FROM notification_inbox
      WHERE execution_id IN (
        SELECT e.effect_execution_id::text
          FROM automation_effect_execution e
          JOIN automation_trigger_event t USING (trigger_event_id)
         WHERE t.automation_id IN (
           SELECT automation_id FROM automation WHERE tenant_id = $1
         )
      )`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM automation_dependency dependency
      WHERE dependency.child_automation_id IN (
              SELECT automation_id FROM automation WHERE tenant_id = $1
            )
         OR dependency.parent_automation_id IN (
              SELECT automation_id FROM automation WHERE tenant_id = $1
            )`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM automation_trigger_event
      WHERE automation_id IN (
        SELECT automation_id FROM automation WHERE tenant_id = $1
      )`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM automation_condition_evaluation
      WHERE automation_id IN (
        SELECT automation_id FROM automation WHERE tenant_id = $1
      )`,
    [tenantId],
  );
  await pool.query(
    "DELETE FROM automation WHERE tenant_id = $1",
    [tenantId],
  );
  createdIds.splice(0);
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM action_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, fallbackActionApiName],
  );
  await pool.end();
});

describe("Automate repository and durable scheduling", () => {
  it("persists drafts, rejects stale revisions, and creates an immutable version", async () => {
    const { created, updated } = await createConfiguredAutomation();
    await expect(
      updateDraft({
        automationId: created.automationId,
        tenantId,
        actorUserId,
        expectedRevision: created.draftRevision,
        definition: updated.draftDefinition,
      }),
    ).rejects.toMatchObject({
      code: "AUTOMATION_VERSION_CONFLICT",
      status: 409,
    });

    const idempotencyKey = crypto.randomUUID();
    const activated = await activateAutomation({
      automationId: created.automationId,
      tenantId,
      actorUserId,
      expectedRevision: updated.draftRevision,
      idempotencyKey,
    });
    const replayed = await activateAutomation({
      automationId: created.automationId,
      tenantId,
      actorUserId,
      expectedRevision: updated.draftRevision,
      idempotencyKey,
    });
    expect(activated.currentVersion).toBe(1);
    expect(replayed.currentVersion).toBe(1);
    const versions = await pool.query(
      "SELECT version FROM automation_version WHERE automation_id = $1",
      [created.automationId],
    );
    expect(versions.rows).toHaveLength(1);
  });

  it("allows concurrent schedulers to create one stable trigger occurrence", async () => {
    const { created, updated } = await createConfiguredAutomation();
    await activateAutomation({
      automationId: created.automationId,
      tenantId,
      actorUserId,
      expectedRevision: updated.draftRevision,
      idempotencyKey: crypto.randomUUID(),
    });
    await pool.query(
      "UPDATE automation SET next_run_at = now() WHERE automation_id = $1",
      [created.automationId],
    );
    const at = new Date(Date.now() + 1_000);
    await Promise.all([
      runAutomateSchedulerOnce(at, 10),
      runAutomateSchedulerOnce(at, 10),
    ]);
    const triggers = await pool.query<{ count: string }>(
      "SELECT count(*) FROM automation_trigger_event WHERE automation_id = $1",
      [created.automationId],
    );
    expect(Number(triggers.rows[0].count)).toBe(1);
  });

  it("claims effects once and recovers them after a worker lease expires", async () => {
    const { created, updated } = await createConfiguredAutomation();
    const activated = await activateAutomation({
      automationId: created.automationId,
      tenantId,
      actorUserId,
      expectedRevision: updated.draftRevision,
      idempotencyKey: crypto.randomUUID(),
    });
    const trigger = await pool.query<{ trigger_event_id: string }>(
      `INSERT INTO automation_trigger_event (
         automation_id, automation_version, trigger_key, trigger_type,
         condition_output, status, execution_principal
       ) VALUES ($1,1,$2,'manual','{}','queued',$3::jsonb)
       RETURNING trigger_event_id`,
      [
        created.automationId,
        `lease:${crypto.randomUUID()}`,
        JSON.stringify({ kind: "user", id: actorUserId }),
      ],
    );
    const effect = activated.draftDefinition.effects[0];
    await pool.query(
      `INSERT INTO automation_effect_execution (
         trigger_event_id, effect_id, effect_type, effect_order, max_attempts
       ) VALUES ($1,$2,'notification',0,2)`,
      [trigger.rows[0].trigger_event_id, effect.id],
    );

    const now = new Date();
    const concurrentClaims = await Promise.all([
      claimAutomateEffects({
        workerId: "worker-a",
        tenantId,
        now,
        limit: 10,
        leaseSeconds: 30,
      }),
      claimAutomateEffects({
        workerId: "worker-b",
        tenantId,
        now,
        limit: 10,
        leaseSeconds: 30,
      }),
    ]);
    expect(concurrentClaims.flat()).toHaveLength(1);
    expect(
      await claimAutomateEffects({
        workerId: "worker-c",
        tenantId,
        now: new Date(now.getTime() + 29_000),
        limit: 10,
        leaseSeconds: 30,
      }),
    ).toHaveLength(0);
    const recovered = await claimAutomateEffects({
      workerId: "worker-c",
      tenantId,
      now: new Date(now.getTime() + 31_000),
      limit: 10,
      leaseSeconds: 30,
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.trigger_event_id).toBe(
      trigger.rows[0].trigger_event_id,
    );
  });

  it("handles a due-work burst across concurrent schedulers and workers", async () => {
    const automationIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const { created, updated } = await createConfiguredAutomation();
      await activateAutomation({
        automationId: created.automationId,
        tenantId,
        actorUserId,
        expectedRevision: updated.draftRevision,
        idempotencyKey: crypto.randomUUID(),
      });
      automationIds.push(created.automationId);
    }
    await pool.query(
      `UPDATE automation
          SET next_run_at = now()
        WHERE automation_id = ANY($1::uuid[])`,
      [automationIds],
    );

    const now = new Date(Date.now() + 1_000);
    await Promise.all(
      Array.from({ length: 4 }, () => runAutomateSchedulerOnce(now, 100)),
    );
    const triggers = await pool.query<{
      trigger_event_id: string;
      automation_id: string;
    }>(
      `SELECT trigger_event_id, automation_id
         FROM automation_trigger_event
        WHERE automation_id = ANY($1::uuid[])`,
      [automationIds],
    );
    expect(triggers.rows).toHaveLength(8);
    expect(new Set(triggers.rows.map((row) => row.automation_id)).size).toBe(8);

    // Drive concurrent claim rounds until every effect is executed
    // exactly once. A co-running automate runtime (e.g. `pnpm dev`)
    // participates through the same leased claim path, so assertions
    // target the terminal state, not which worker claimed each effect.
    const deadline = Date.now() + 30_000;
    const claimedByTest = new Set<string>();
    for (;;) {
      // Each effect must be executed with the same workerId that
      // claimed it: executeClaimedEffect's lease checks no-op
      // silently on a lease_owner mismatch.
      const claims = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          claimAutomateEffects({
            workerId: `burst-worker-${index}`,
            tenantId,
            now: new Date(Date.now() + 1_000),
            limit: 100,
            leaseSeconds: 30,
          }).then((rows) =>
            rows.map((row) => ({ row, workerId: `burst-worker-${index}` })),
          ),
        ),
      );
      const claimed = claims.flat();
      for (const { row } of claimed) {
        expect(claimedByTest.has(row.effect_execution_id)).toBe(false);
        claimedByTest.add(row.effect_execution_id);
      }
      await Promise.all(
        claimed.map(({ row, workerId }) =>
          executeClaimedEffect(row, workerId, async () => ({
            burst: true,
          })),
        ),
      );
      const remaining = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM automation_effect_execution e
           JOIN automation_trigger_event t USING (trigger_event_id)
          WHERE t.automation_id = ANY($1::uuid[])
            AND e.status IN ('pending','retrying','claimed','running')`,
        [automationIds],
      );
      if (Number(remaining.rows[0].count) === 0) break;
      expect(Date.now()).toBeLessThan(deadline);
      if (claimed.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // Exactly-once: eight effects, each succeeded on its first attempt.
    const effects = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM automation_effect_execution e
         JOIN automation_trigger_event t USING (trigger_event_id)
        WHERE t.automation_id = ANY($1::uuid[])
          AND e.status = 'succeeded' AND e.attempt_count = 1`,
      [automationIds],
    );
    expect(Number(effects.rows[0].count)).toBe(8);
    const attempts = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM automation_effect_attempt a
         JOIN automation_effect_execution e USING (effect_execution_id)
         JOIN automation_trigger_event t USING (trigger_event_id)
        WHERE t.automation_id = ANY($1::uuid[])`,
      [automationIds],
    );
    expect(Number(attempts.rows[0].count)).toBe(8);
  });

  it("executes parallel effects independently when one fails", async () => {
    const failedEffect = {
      ...notificationEffect(),
      id: crypto.randomUUID(),
      name: "Fails independently",
      order: 0,
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
    };
    const successfulEffect = {
      ...notificationEffect(),
      id: crypto.randomUUID(),
      name: "Succeeds independently",
      order: 1,
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
    };
    const activated = await createActivatedAutomation((definition) => ({
      ...definition,
      effects: [failedEffect, successfulEffect],
      executionStrategy: {
        mode: "parallel",
        queueTriggerEvents: false,
      },
    }));
    await pool.query(
      "UPDATE automation SET next_run_at = now() WHERE automation_id = $1",
      [activated.automationId],
    );
    const now = new Date(Date.now() + 1_000);
    await runAutomateSchedulerOnce(now, 10);
    const claimed = await claimAutomateEffects({
      workerId: "parallel-worker",
      tenantId,
      now,
      limit: 10,
    });
    expect(claimed).toHaveLength(2);
    await Promise.all(
      claimed.map((row) =>
        executeClaimedEffect(
          row,
          "parallel-worker",
          async ({ effect }) => {
            if (effect.id === failedEffect.id) {
              throw Object.assign(new Error("Deterministic test failure"), {
                code: "TEST_FAILURE",
                status: 400,
              });
            }
            return { independent: true };
          },
        ),
      ),
    );

    const statuses = await pool.query<{
      effect_id: string;
      status: string;
    }>(
      `SELECT effect.effect_id::text, effect.status
         FROM automation_effect_execution effect
         JOIN automation_trigger_event trigger
           ON trigger.trigger_event_id = effect.trigger_event_id
        WHERE trigger.automation_id = $1`,
      [activated.automationId],
    );
    expect(
      Object.fromEntries(
        statuses.rows.map((row) => [row.effect_id, row.status]),
      ),
    ).toMatchObject({
      [failedEffect.id]: "exhausted",
      [successfulEffect.id]: "succeeded",
    });
  });

  it("skips later sequential effects after an unresolved failure", async () => {
    const first = {
      ...notificationEffect(),
      id: crypto.randomUUID(),
      name: "First sequential effect",
      order: 0,
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
    };
    const second = {
      ...notificationEffect(),
      id: crypto.randomUUID(),
      name: "Second sequential effect",
      order: 1,
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
    };
    const activated = await createActivatedAutomation((definition) => ({
      ...definition,
      effects: [first, second],
      executionStrategy: {
        mode: "sequential",
        queueTriggerEvents: false,
      },
    }));
    await pool.query(
      "UPDATE automation SET next_run_at = now() WHERE automation_id = $1",
      [activated.automationId],
    );
    const now = new Date(Date.now() + 1_000);
    await runAutomateSchedulerOnce(now, 10);
    const claimed = await claimAutomateEffects({
      workerId: "sequential-worker",
      tenantId,
      now,
      limit: 10,
    });
    expect(claimed.map((row) => row.effect_id)).toEqual([first.id]);
    await executeClaimedEffect(
      claimed[0],
      "sequential-worker",
      async () => {
        throw Object.assign(new Error("Deterministic sequential failure"), {
          code: "TEST_FAILURE",
          status: 400,
        });
      },
    );
    const statuses = await pool.query<{
      effect_id: string;
      status: string;
      error_code: string | null;
    }>(
      `SELECT effect.effect_id::text, effect.status, effect.error_code
         FROM automation_effect_execution effect
         JOIN automation_trigger_event trigger
           ON trigger.trigger_event_id = effect.trigger_event_id
        WHERE trigger.automation_id = $1`,
      [activated.automationId],
    );
    expect(
      Object.fromEntries(
        statuses.rows.map((row) => [
          row.effect_id,
          { status: row.status, errorCode: row.error_code },
        ]),
      ),
    ).toMatchObject({
      [first.id]: { status: "exhausted", errorCode: "TEST_FAILURE" },
      [second.id]: {
        status: "skipped",
        errorCode: "PREVIOUS_EFFECT_FAILED",
      },
    });
  });

  it("lets a successful fallback resolve a sequential failure", async () => {
    const fallback = {
      id: crypto.randomUUID(),
      name: "Resolve with fallback Action",
      order: 0,
      type: "action" as const,
      actionTypeId: fallbackActionTypeId,
      actionApiName: fallbackActionApiName,
      definitionVersion: 1,
      definitionHash: null,
      parameters: {},
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
    };
    const primary = {
      ...notificationEffect(),
      id: crypto.randomUUID(),
      name: "Primary with fallback",
      order: 0,
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
      fallbackEffect: fallback,
    };
    const later = {
      ...notificationEffect(),
      id: crypto.randomUUID(),
      name: "Runs after resolved fallback",
      order: 1,
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
    };
    const activated = await createActivatedAutomation((definition) => ({
      ...definition,
      effects: [primary, later],
      executionStrategy: {
        mode: "sequential",
        queueTriggerEvents: false,
      },
    }));
    await pool.query(
      "UPDATE automation SET next_run_at = now() WHERE automation_id = $1",
      [activated.automationId],
    );
    const now = new Date(Date.now() + 1_000);
    await runAutomateSchedulerOnce(now, 10);

    const primaryClaim = await claimAutomateEffects({
      workerId: "fallback-worker",
      tenantId,
      now,
      limit: 10,
    });
    expect(primaryClaim.map((row) => row.effect_id)).toEqual([primary.id]);
    await executeClaimedEffect(
      primaryClaim[0],
      "fallback-worker",
      async () => {
        throw Object.assign(new Error("Primary failed"), {
          code: "TEST_PRIMARY_FAILURE",
          status: 400,
        });
      },
    );

    const fallbackClaim = await claimAutomateEffects({
      workerId: "fallback-worker",
      tenantId,
      now,
      limit: 10,
    });
    expect(fallbackClaim.map((row) => row.effect_id)).toEqual([fallback.id]);
    await executeClaimedEffect(
      fallbackClaim[0],
      "fallback-worker",
      async () => ({ fallbackResolved: true }),
    );

    const laterClaim = await claimAutomateEffects({
      workerId: "fallback-worker",
      tenantId,
      now,
      limit: 10,
    });
    expect(laterClaim.map((row) => row.effect_id)).toEqual([later.id]);
    await executeClaimedEffect(
      laterClaim[0],
      "fallback-worker",
      async () => ({ ranAfterFallback: true }),
    );

    const effects = await pool.query<{
      effect_id: string;
      is_fallback: boolean;
      status: string;
      output: Record<string, unknown> | null;
    }>(
      `SELECT effect.effect_id::text, effect.is_fallback,
              effect.status, effect.output
         FROM automation_effect_execution effect
         JOIN automation_trigger_event trigger
           ON trigger.trigger_event_id = effect.trigger_event_id
        WHERE trigger.automation_id = $1`,
      [activated.automationId],
    );
    expect(
      Object.fromEntries(
        effects.rows.map((row) => [
          row.effect_id,
          { status: row.status, output: row.output },
        ]),
      ),
    ).toMatchObject({
      [primary.id]: {
        status: "succeeded",
        output: {
          resolvedByFallbackEffectExecutionId:
            fallbackClaim[0].effect_execution_id,
        },
      },
      [fallback.id]: {
        status: "succeeded",
        output: { fallbackResolved: true },
      },
      [later.id]: {
        status: "succeeded",
        output: { ranAfterFallback: true },
      },
    });
  });

  it("persists legal lifecycle transitions and rejects archive recovery", async () => {
    const activated = await createActivatedAutomation((definition) => definition);
    const transition = (target: "active" | "paused" | "muted" | "archived") =>
      transitionAutomation({
        automationId: activated.automationId,
        tenantId,
        actorUserId,
        target,
        reason: `Integration transition to ${target}`,
      });

    expect((await transition("paused")).status).toBe("paused");
    expect((await transition("active")).status).toBe("active");
    const muted = await transition("muted");
    expect(muted.status).toBe("muted");
    expect(muted.muteReason).toBe("Integration transition to muted");
    expect((await transition("active")).status).toBe("active");
    expect((await transition("archived")).status).toBe("archived");

    await expect(transition("active")).rejects.toMatchObject({
      code: "AUTOMATION_LIFECYCLE_TRANSITION_INVALID",
      status: 409,
    });
    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type
         FROM automation_audit_event
        WHERE automation_id = $1
          AND event_type IN (
            'automation.paused',
            'automation.resumed',
            'automation.muted',
            'automation.unmuted',
            'automation.archived'
          )`,
      [activated.automationId],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "automation.paused",
        "automation.resumed",
        "automation.muted",
        "automation.unmuted",
        "automation.archived",
      ]),
    );
  });

  it("projects execution, attempt, evaluation, and audit history", async () => {
    const effect = {
      ...notificationEffect(),
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
    };
    const activated = await createActivatedAutomation((definition) => ({
      ...definition,
      effects: [effect],
    }));
    await pool.query(
      "UPDATE automation SET next_run_at = now() WHERE automation_id = $1",
      [activated.automationId],
    );
    const now = new Date(Date.now() + 1_000);
    await runAutomateSchedulerOnce(now, 10);
    const claimed = await claimAutomateEffects({
      workerId: "history-worker",
      tenantId,
      now,
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    await executeClaimedEffect(
      claimed[0],
      "history-worker",
      async () => ({ deliveryId: "history-delivery" }),
    );

    const history = await listExecutionHistory({
      automationId: activated.automationId,
      tenantId,
      actorUserId,
      limit: 50,
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "succeeded",
      automationVersion: 1,
      effects: [
        {
          effectId: effect.id,
          status: "succeeded",
          attemptCount: 1,
          output: { deliveryId: "history-delivery" },
          attempts: [{ attemptNumber: 1, status: "succeeded" }],
        },
      ],
    });
    const details = await getExecutionDetails({
      automationId: activated.automationId,
      triggerEventId: history[0].triggerEventId as string,
      tenantId,
      actorUserId,
    });
    expect(details).toMatchObject({
      triggerEventId: history[0].triggerEventId,
      effects: [
        {
          input: expect.any(Object),
          output: { deliveryId: "history-delivery" },
        },
      ],
    });
    const evaluations = await listConditionEvaluations({
      automationId: activated.automationId,
      tenantId,
      actorUserId,
      limit: 100,
    });
    expect(evaluations.length).toBeGreaterThanOrEqual(1);
    const audit = await listAutomationAudit({
      automationId: activated.automationId,
      tenantId,
      actorUserId,
      limit: 100,
    });
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "automation.activated" }),
      ]),
    );
  });

  it("automatically schedules retryable event failures with durable lineage", async () => {
    const configuredEffect = {
      ...notificationEffect(),
      id: crypto.randomUUID(),
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
    };
    const activated = await createActivatedAutomation((definition) => ({
      ...definition,
      effects: [configuredEffect],
      settings: {
        ...definition.settings,
        eventRetries: {
          enabled: true,
          maxRetries: 2,
          intervalSeconds: 60,
        },
      },
    }));
    await pool.query(
      "UPDATE automation SET next_run_at = now() WHERE automation_id = $1",
      [activated.automationId],
    );
    const now = new Date(Date.now() + 1_000);
    await runAutomateSchedulerOnce(now, 10);
    const claimed = await claimAutomateEffects({
      workerId: "automatic-event-retry-worker",
      tenantId,
      now,
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    await executeClaimedEffect(
      claimed[0],
      "automatic-event-retry-worker",
      async () => {
        throw Object.assign(new Error("Retryable provider outage"), {
          code: "TEST_PROVIDER_OUTAGE",
          status: 503,
        });
      },
    );

    const retry = await pool.query<{
      trigger_event_id: string;
      retry_of_trigger_event_id: string;
      scheduled_for: Date | string;
      effect_status: string;
    }>(
      `SELECT retry.trigger_event_id, retry.retry_of_trigger_event_id,
              retry.scheduled_for, effect.status AS effect_status
         FROM automation_trigger_event retry
         JOIN automation_effect_execution effect
           ON effect.trigger_event_id = retry.trigger_event_id
        WHERE retry.retry_of_trigger_event_id = $1`,
      [claimed[0].trigger_event_id],
    );
    expect(retry.rows).toHaveLength(1);
    expect(retry.rows[0]).toMatchObject({
      retry_of_trigger_event_id: claimed[0].trigger_event_id,
      effect_status: "pending",
    });
    expect(new Date(retry.rows[0].scheduled_for).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("creates a child trigger from a persisted parent completion event", async () => {
    const parent = await createActivatedAutomation((definition) => definition);
    const child = await createActivatedAutomation((definition) => ({
      ...definition,
      condition: {
        type: "automation-dependency",
        evaluationMode: "automation-dependent",
        parentAutomationId: parent.automationId,
        delaySeconds: 0,
        completionStatuses: ["succeeded"],
      },
    }));
    await pool.query(
      "UPDATE automation SET next_run_at = now() WHERE automation_id = $1",
      [parent.automationId],
    );
    const now = new Date(Date.now() + 1_000);
    await runAutomateSchedulerOnce(now, 10);
    const parentClaim = await claimAutomateEffects({
      workerId: "dependency-worker",
      tenantId,
      now,
      limit: 10,
    });
    expect(parentClaim).toHaveLength(1);
    expect(parentClaim[0].automation_id).toBe(parent.automationId);
    await executeClaimedEffect(
      parentClaim[0],
      "dependency-worker",
      async () => ({ parentCompleted: true }),
    );

    const childEvent = await pool.query<{
      trigger_event_id: string;
      caused_by_trigger_event_id: string;
      trigger_type: string;
    }>(
      `SELECT trigger_event_id, caused_by_trigger_event_id, trigger_type
         FROM automation_trigger_event
        WHERE automation_id = $1`,
      [child.automationId],
    );
    expect(childEvent.rows).toHaveLength(1);
    expect(childEvent.rows[0]).toMatchObject({
      caused_by_trigger_event_id: parentClaim[0].trigger_event_id,
      trigger_type: "automation-dependency",
    });

    const childClaim = await claimAutomateEffects({
      workerId: "dependency-worker",
      tenantId,
      now,
      limit: 10,
    });
    expect(childClaim).toHaveLength(1);
    expect(childClaim[0].automation_id).toBe(child.automationId);
    await executeClaimedEffect(
      childClaim[0],
      "dependency-worker",
      async () => ({ childCompleted: true }),
    );
    const childStatus = await pool.query<{ status: string }>(
      `SELECT status
         FROM automation_trigger_event
        WHERE trigger_event_id = $1`,
      [childEvent.rows[0].trigger_event_id],
    );
    expect(childStatus.rows[0]?.status).toBe("succeeded");
  });

  it("serializes separate trigger events without changing effect ordering", async () => {
    const activated = await createActivatedAutomation((definition) => ({
      ...definition,
      executionStrategy: {
        ...definition.executionStrategy,
        mode: "parallel",
        queueTriggerEvents: true,
      },
    }));
    const effect = activated.draftDefinition.effects[0];
    const firstKey = `queue-first:${crypto.randomUUID()}`;
    const secondKey = `queue-second:${crypto.randomUUID()}`;
    const triggers = await pool.query<{
      trigger_event_id: string;
      trigger_key: string;
    }>(
      `INSERT INTO automation_trigger_event (
         automation_id, automation_version, trigger_key, trigger_type,
         condition_output, status, execution_principal, created_at
       ) VALUES
         ($1,1,$2,'manual','{}','queued',$4::jsonb,now() - interval '1 second'),
         ($1,1,$3,'manual','{}','queued',$4::jsonb,now())
       RETURNING trigger_event_id, trigger_key`,
      [
        activated.automationId,
        firstKey,
        secondKey,
        JSON.stringify({ kind: "user", id: actorUserId }),
      ],
    );
    const firstTriggerId = triggers.rows.find(
      (trigger) => trigger.trigger_key === firstKey,
    )!.trigger_event_id;
    const secondTriggerId = triggers.rows.find(
      (trigger) => trigger.trigger_key === secondKey,
    )!.trigger_event_id;
    for (const trigger of triggers.rows) {
      await pool.query(
        `INSERT INTO automation_effect_execution (
           trigger_event_id, effect_id, effect_type, effect_order, max_attempts
         ) VALUES ($1,$2,$3,0,1)`,
        [trigger.trigger_event_id, effect.id, effect.type],
      );
    }
    // Claim and execute until both triggers' effects complete. A
    // co-running automate runtime may claim some effects first, so the
    // test asserts the serialization invariant — the second trigger's
    // effect is never claimable before the first trigger completes —
    // rather than which worker performed each claim.
    const deadline = Date.now() + 30_000;
    const claimedIds = new Set<string>();
    let secondClaimedBeforeFirstCompleted = false;
    for (;;) {
      const claimed = await claimAutomateEffects({
        workerId: "trigger-queue-worker",
        tenantId,
        now: new Date(Date.now() + 1_000),
        limit: 10,
      });
      for (const row of claimed) {
        expect(claimedIds.has(row.effect_execution_id)).toBe(false);
        claimedIds.add(row.effect_execution_id);
        if (row.trigger_event_id === secondTriggerId) {
          const first = await pool.query<{ status: string }>(
            `SELECT status
               FROM automation_effect_execution
              WHERE trigger_event_id = $1`,
            [firstTriggerId],
          );
          if (first.rows[0]?.status !== "succeeded") {
            secondClaimedBeforeFirstCompleted = true;
          }
        }
        await executeClaimedEffect(
          row,
          "trigger-queue-worker",
          async () => ({ completed: "queued" }),
        );
      }
      const remaining = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM automation_effect_execution
          WHERE trigger_event_id = ANY($1::uuid[])
            AND status IN ('pending','retrying','claimed','running')`,
        [[firstTriggerId, secondTriggerId]],
      );
      if (Number(remaining.rows[0].count) === 0) break;
      expect(Date.now()).toBeLessThan(deadline);
      if (claimed.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    expect(secondClaimedBeforeFirstCompleted).toBe(false);

    // The second effect started only after the first completed,
    // regardless of which worker executed them.
    const ordering = await pool.query<{
      first_completed: string | null;
      second_started: string | null;
      ordered: boolean | null;
    }>(
      `SELECT
         (SELECT completed_at FROM automation_effect_execution
           WHERE trigger_event_id = $1)::text AS first_completed,
         (SELECT started_at FROM automation_effect_execution
           WHERE trigger_event_id = $2)::text AS second_started,
         (
           (SELECT started_at FROM automation_effect_execution
             WHERE trigger_event_id = $2)
           >=
           (SELECT completed_at FROM automation_effect_execution
             WHERE trigger_event_id = $1)
         ) AS ordered`,
      [firstTriggerId, secondTriggerId],
    );
    expect(ordering.rows[0].first_completed).not.toBeNull();
    expect(ordering.rows[0].second_started).not.toBeNull();
    expect(ordering.rows[0].ordered).toBe(true);
  });

  it("auto-mutes deterministically and records the runtime decision", async () => {
    const configuredEffect = {
      ...notificationEffect(),
      id: crypto.randomUUID(),
      retry: {
        ...notificationEffect().retry,
        enabled: false,
        maxAttempts: 1,
      },
    };
    const activated = await createActivatedAutomation((definition) => ({
      ...definition,
      effects: [configuredEffect],
      settings: {
        ...definition.settings,
        autoMute: {
          enabled: true,
          minimumExecutions: 2,
          failureRateThreshold: 1,
          evaluationWindowSeconds: 3_600,
        },
      },
    }));
    const failOneEvent = async (sequence: number) => {
      const event = await pool.query<{ trigger_event_id: string }>(
        `INSERT INTO automation_trigger_event (
           automation_id, automation_version, trigger_key, trigger_type,
           condition_output, status, execution_principal
         ) VALUES ($1,1,$2,'manual','{}','queued',$3::jsonb)
         RETURNING trigger_event_id`,
        [
          activated.automationId,
          `auto-mute:${sequence}:${crypto.randomUUID()}`,
          JSON.stringify({ kind: "user", id: actorUserId }),
        ],
      );
      await pool.query(
        `INSERT INTO automation_effect_execution (
           trigger_event_id, effect_id, effect_type, effect_order, max_attempts
         ) VALUES ($1,$2,$3,0,1)`,
        [event.rows[0].trigger_event_id, configuredEffect.id, configuredEffect.type],
      );
      const claimed = await claimAutomateEffects({
        workerId: "auto-mute-worker",
        tenantId,
        now: new Date(Date.now() + 1_000),
        limit: 1,
      });
      expect(claimed).toHaveLength(1);
      await executeClaimedEffect(
        claimed[0],
        "auto-mute-worker",
        async () => {
          throw Object.assign(new Error("Deterministic permanent failure"), {
            code: "TEST_PERMANENT_FAILURE",
            status: 400,
          });
        },
      );
    };

    await failOneEvent(1);
    const afterFirst = await pool.query<{ status: string }>(
      "SELECT status FROM automation WHERE automation_id = $1",
      [activated.automationId],
    );
    expect(afterFirst.rows[0]?.status).toBe("active");

    await failOneEvent(2);
    const muted = await pool.query<{
      status: string;
      mute_reason: string | null;
    }>(
      "SELECT status, mute_reason FROM automation WHERE automation_id = $1",
      [activated.automationId],
    );
    expect(muted.rows[0]).toMatchObject({
      status: "muted",
      mute_reason:
        "Automatic mute: execution failure threshold reached",
    });
    const audit = await pool.query<{ count: string | number }>(
      `SELECT count(*) AS count
         FROM automation_audit_event
        WHERE automation_id = $1
          AND event_type = 'automation.auto_muted'`,
      [activated.automationId],
    );
    expect(Number(audit.rows[0]?.count ?? 0)).toBe(1);
  });

  it("enforces the event retry limit across retries of retries", async () => {
    const { created, updated } = await createConfiguredAutomation(2);
    const activated = await activateAutomation({
      automationId: created.automationId,
      tenantId,
      actorUserId,
      expectedRevision: updated.draftRevision,
      idempotencyKey: crypto.randomUUID(),
    });
    const effect = activated.draftDefinition.effects[0];
    const original = await pool.query<{ trigger_event_id: string }>(
      `INSERT INTO automation_trigger_event (
         automation_id, automation_version, trigger_key, trigger_type,
         condition_output, status, execution_principal, completed_at
       ) VALUES ($1,1,$2,'manual','{}','failed',$3::jsonb,now())
       RETURNING trigger_event_id`,
      [
        created.automationId,
        `integration:${crypto.randomUUID()}`,
        JSON.stringify({ kind: "user", id: actorUserId }),
      ],
    );
    await pool.query(
      `INSERT INTO automation_effect_execution (
         trigger_event_id, effect_id, effect_type, effect_order,
         max_attempts, status, completed_at
       ) VALUES ($1,$2,'notification',0,2,'exhausted',now())`,
      [original.rows[0].trigger_event_id, effect.id],
    );
    const successfulEffectId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO automation_effect_execution (
         trigger_event_id, effect_id, effect_type, effect_order,
         max_attempts, status, output, completed_at
       ) VALUES ($1,$2,'notification',1,1,'succeeded',$3::jsonb,now())`,
      [
        original.rows[0].trigger_event_id,
        successfulEffectId,
        JSON.stringify({ reusable: true }),
      ],
    );

    const first = await retryTriggerEvent({
      automationId: created.automationId,
      triggerEventId: original.rows[0].trigger_event_id,
      tenantId,
      actorUserId,
      idempotencyKey: crypto.randomUUID(),
    });
    const reused = await pool.query<{ status: string; output: unknown }>(
      `SELECT status, output FROM automation_effect_execution
        WHERE trigger_event_id = $1 AND effect_id = $2`,
      [first.triggerEventId, successfulEffectId],
    );
    expect(reused.rows[0]).toMatchObject({
      status: "succeeded",
      output: { reusable: true },
    });
    await pool.query(
      `UPDATE automation_trigger_event
          SET status = 'failed', completed_at = now()
        WHERE trigger_event_id = $1`,
      [first.triggerEventId],
    );
    await pool.query(
      `UPDATE automation_effect_execution
          SET status = 'exhausted', completed_at = now()
        WHERE trigger_event_id = $1 AND status <> 'succeeded'`,
      [first.triggerEventId],
    );
    const second = await retryTriggerEvent({
      automationId: created.automationId,
      triggerEventId: first.triggerEventId,
      tenantId,
      actorUserId,
      idempotencyKey: crypto.randomUUID(),
    });
    await pool.query(
      `UPDATE automation_trigger_event
          SET status = 'failed', completed_at = now()
        WHERE trigger_event_id = $1`,
      [second.triggerEventId],
    );
    await pool.query(
      `UPDATE automation_effect_execution
          SET status = 'exhausted', completed_at = now()
        WHERE trigger_event_id = $1 AND status <> 'succeeded'`,
      [second.triggerEventId],
    );
    try {
      await retryTriggerEvent({
        automationId: created.automationId,
        triggerEventId: second.triggerEventId,
        tenantId,
        actorUserId,
        idempotencyKey: crypto.randomUUID(),
      });
      throw new Error("Expected the retry limit to reject the request.");
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationServiceError);
      expect((error as AutomationServiceError).code).toBe(
        "AUTOMATION_EVENT_RETRIES_EXHAUSTED",
      );
    }
  });
});
