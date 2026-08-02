import crypto from "crypto";
import { pool } from "../../db";
import { executeAction } from "../../actions/actionExecutor";
import {
  checkIdempotencyKey,
  storeIdempotencyKey,
  withIdempotencyLock,
} from "../../actions/idempotency";
import { getKeycloakAdminService } from "../keycloakAdminService";
import { incCounter } from "../funnel/metrics";
import {
  AutomationDraftSchema,
  type AutomationDraft,
  type EffectDraft,
  type ValueBinding,
} from "./contracts";
import { nextScheduleOccurrence } from "./schedule";
import { retryDelaySeconds, shouldAutoMute } from "./retry";
import {
  hasRuntimeMarkingBypass,
  isExecutableOwner,
} from "./permissions";
import {
  runAutomateConditionEvaluatorOnce,
  runAutomateLiveEventsOnce,
} from "./conditionRuntime";
import {
  executeFunctionEffect,
  executeNotificationEffect,
} from "./effectExecutors";
import {
  appendAutomationAudit,
  retryTriggerEvent,
} from "./repository";

const DEFAULT_BATCH = 16;
const DEFAULT_LEASE_SECONDS = 120;

class EffectLeaseLostError extends Error {
  constructor() {
    super("The effect worker lease is no longer owned by this worker.");
    this.name = "EffectLeaseLostError";
  }
}

export interface ClaimedEffect {
  effect_execution_id: string;
  trigger_event_id: string;
  effect_id: string;
  effect_order: number;
  is_fallback: boolean;
  parent_effect_execution_id: string | null;
  attempt_count: number;
  max_attempts: number;
  condition_output: Record<string, unknown>;
  automation_id: string;
  automation_version: number;
  tenant_id: string;
  ontology_id: string;
  owner_user_id: string;
  owner_security_snapshot: {
    roles?: string[];
    groups?: string[];
    markings?: string[];
    cbac?: string[];
    markingBypass?: boolean;
  };
  definition: unknown;
}

export type AutomateEffectExecutionAdapter = (input: {
  row: ClaimedEffect;
  effect: EffectDraft;
  parameters: Record<string, unknown>;
  conditionOutput: Record<string, unknown>;
  effectOutputs: Record<string, Record<string, unknown>>;
}) => Promise<Record<string, unknown>>;

function startEffectHeartbeat(
  effectExecutionId: string,
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): () => Promise<void> {
  let renewal = Promise.resolve();
  const intervalMs = Math.max(1_000, Math.floor((leaseSeconds * 1_000) / 3));
  const timer = setInterval(() => {
    renewal = pool
      .query(
        `UPDATE automation_effect_execution
            SET heartbeat_at = now(),
                lease_expires_at = now() + make_interval(secs => $3),
                updated_at = now()
          WHERE effect_execution_id = $1
            AND lease_owner = $2
            AND status = 'running'`,
        [effectExecutionId, workerId, leaseSeconds],
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            type: "automate.effect.heartbeat_failed",
            effectExecutionId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await renewal;
  };
}

async function insertAutomationSystemNotifications(
  client: import("pg").PoolClient,
  input: {
    definition: AutomationDraft;
    ownerUserId: string;
    automationId: string;
    ontologyId: string;
    executionId: string;
    category: "effect-failure" | "auto-muted";
    message: string;
  },
): Promise<void> {
  const audience =
    input.category === "effect-failure"
      ? input.definition.settings.effectFailureNotificationAudience
      : input.definition.settings.informationNotificationAudience;
  const recipients =
    audience === "administrators"
      ? input.definition.settings.administrators
          .filter((principal) => principal.kind === "user")
          .map((principal) => principal.id)
      : [
          input.ownerUserId,
          ...input.definition.effects.flatMap((effect) =>
            effect.type === "notification"
              ? effect.recipients.static
                  .filter((principal) => principal.kind === "user")
                  .map((principal) => principal.id)
              : [],
          ),
        ];
  for (const recipient of [...new Set(recipients)]) {
    await client.query(
      `INSERT INTO notification_inbox (
         recipient_user_id, template_id, template_parameters, channel,
         action_type_api_name, execution_id, ontology_id
       ) VALUES ($1,$2,$3::jsonb,'in_app','tellus-automate',$4,$5)`,
      [
        recipient,
        `automate.${input.category}`,
        JSON.stringify({
          automationId: input.automationId,
          message: input.message,
        }),
        input.executionId,
        input.ontologyId,
      ],
    );
  }
}

function metric(name: string, labels: Record<string, string> = {}): void {
  try {
    incCounter(name, labels);
  } catch {
    // Metrics must never change durable execution behavior.
  }
}

function atPath(value: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let cursor = value;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function resolveBinding(
  binding: ValueBinding,
  context: {
    conditionOutput: Record<string, unknown>;
    automationId: string;
    automationVersion: number;
    triggerEventId: string;
    ownerId: string;
    effectOutputs: Record<string, unknown>;
  },
): unknown {
  if (binding.kind === "constant") return binding.value;
  if (binding.kind === "condition-output") {
    return atPath(context.conditionOutput, binding.path);
  }
  if (binding.kind === "object-property") {
    const object = atPath(context.conditionOutput, binding.objectPath);
    return atPath(object, binding.propertyId);
  }
  if (binding.kind === "effect-output") {
    return atPath(context.effectOutputs[binding.effectId], binding.path);
  }
  const values = {
    triggeredAt: context.conditionOutput.triggeredAt,
    automationId: context.automationId,
    automationVersion: context.automationVersion,
    triggerEventId: context.triggerEventId,
    ownerId: context.ownerId,
  };
  return values[binding.value];
}

async function previousEffectOutputs(
  triggerEventId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const result = await pool.query<{
    effect_id: string;
    output: unknown;
  }>(
    `SELECT effect_id, output
       FROM automation_effect_execution
      WHERE trigger_event_id = $1 AND status = 'succeeded'`,
    [triggerEventId],
  );
  return Object.fromEntries(
    result.rows.map((row) => [
      row.effect_id,
      row.output !== null &&
      typeof row.output === "object" &&
      !Array.isArray(row.output)
        ? (row.output as Record<string, unknown>)
        : {},
    ]),
  );
}

function effectParameters(
  effect: EffectDraft,
  context: Parameters<typeof resolveBinding>[1],
): Record<string, unknown> {
  if (effect.type === "notification") return {};
  return Object.fromEntries(
    Object.entries(effect.parameters).map(([key, binding]) => [
      key,
      resolveBinding(binding, context),
    ]),
  );
}

export async function runAutomateSchedulerOnce(
  now = new Date(),
  limit = DEFAULT_BATCH,
): Promise<number> {
  const client = await pool.connect();
  let created = 0;
  try {
    await client.query("BEGIN");
    const due = await client.query<{
      automation_id: string;
      current_version: number;
      status: "active" | "muted";
      next_run_at: Date;
      owner_user_id: string;
      owner_security_snapshot: Record<string, unknown>;
      definition: unknown;
    }>(
      `SELECT a.automation_id, a.current_version, a.status, a.next_run_at,
              a.owner_user_id, a.owner_security_snapshot, v.definition
         FROM automation a
         JOIN automation_version v
           ON v.automation_id = a.automation_id
          AND v.version = a.current_version
        WHERE a.status IN ('active','muted')
          AND a.next_run_at <= $1
        ORDER BY a.next_run_at, a.automation_id
        FOR UPDATE OF a SKIP LOCKED
        LIMIT $2`,
      [now, limit],
    );
    for (const row of due.rows) {
      const definition = AutomationDraftSchema.parse(row.definition);
      if (!("schedule" in definition.condition) || !definition.condition.schedule) {
        const muted = await client.query(
          `UPDATE automation
              SET status = 'disabled', next_run_at = NULL,
                  updated_at = now()
            WHERE automation_id = $1`,
          [row.automation_id],
        );
        continue;
      }
      const schedule = definition.condition.schedule;
      const dueAt = new Date(row.next_run_at);
      const late = dueAt.getTime() < now.getTime();
      const shouldFire =
        !late || schedule.missedRunPolicy === "fire-once";
      const nextAt = nextScheduleOccurrence(schedule, now);
      await client.query(
        `UPDATE automation SET next_run_at = $2, updated_at = now()
          WHERE automation_id = $1`,
        [row.automation_id, nextAt],
      );
      if (!shouldFire) continue;

      if (definition.condition.type !== "time") {
        await client.query(
          `INSERT INTO automation_condition_evaluation (
             automation_id, automation_version, evaluation_key, scheduled_for
           ) VALUES ($1,$2,$3,$4)
           ON CONFLICT (evaluation_key) DO NOTHING`,
          [
            row.automation_id,
            row.current_version,
            `scheduled-evaluation:${row.automation_id}:${row.current_version}:${dueAt.toISOString()}`,
            dueAt,
          ],
        );
        continue;
      }

      await client.query(
        `INSERT INTO automation_condition_evaluation (
           automation_id, automation_version, evaluation_key, scheduled_for,
           status, examined_count, matched_count, started_at, completed_at,
           updated_at
         ) VALUES ($1,$2,$3,$4,'succeeded',1,1,now(),now(),now())
         ON CONFLICT (evaluation_key) DO NOTHING`,
        [
          row.automation_id,
          row.current_version,
          `time-evaluation:${row.automation_id}:${row.current_version}:${dueAt.toISOString()}`,
          dueAt,
        ],
      );
      const triggerKey =
        `schedule:${row.automation_id}:${row.current_version}:${dueAt.toISOString()}`;
      const event = await client.query<{ trigger_event_id: string }>(
        `INSERT INTO automation_trigger_event (
           automation_id, automation_version, trigger_key, trigger_type,
           condition_output, status, scheduled_for, execution_principal,
           completed_at
         ) VALUES (
           $1,$2,$3,'time',$4::jsonb,$5,$6,$7::jsonb,
           CASE WHEN $5 = 'skipped' THEN now() ELSE NULL END
         )
         ON CONFLICT (trigger_key) DO NOTHING
         RETURNING trigger_event_id`,
        [
          row.automation_id,
          row.current_version,
          triggerKey,
          JSON.stringify({
            triggeredAt: now.toISOString(),
            scheduledFor: dueAt.toISOString(),
          }),
          row.status === "muted" ? "skipped" : "queued",
          dueAt,
          JSON.stringify({
            kind: "user",
            id: row.owner_user_id,
            security: row.owner_security_snapshot,
          }),
        ],
      );
      const triggerEventId = event.rows[0]?.trigger_event_id;
      if (!triggerEventId || row.status === "muted") continue;
      for (const effect of definition.effects) {
        await client.query(
          `INSERT INTO automation_effect_execution (
             trigger_event_id, effect_id, effect_type, effect_order,
             max_attempts
           ) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (trigger_event_id, effect_id, is_fallback) DO NOTHING`,
          [
            triggerEventId,
            effect.id,
            effect.type,
            effect.order,
            effect.retry.enabled ? effect.retry.maxAttempts : 1,
          ],
        );
      }
      created += 1;
      metric("tellus_automate_trigger_event_total", { trigger: "time" });
    }
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function claimAutomateEffects(input: {
  workerId: string;
  now?: Date;
  limit?: number;
  leaseSeconds?: number;
  tenantId?: string;
}): Promise<ClaimedEffect[]> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? DEFAULT_BATCH;
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const result = await pool.query<ClaimedEffect>(
    `WITH eligible AS (
       SELECT e.effect_execution_id
         FROM automation_effect_execution e
         JOIN automation_trigger_event t ON t.trigger_event_id = e.trigger_event_id
         JOIN automation a ON a.automation_id = t.automation_id
         JOIN automation_version v
           ON v.automation_id = t.automation_id
          AND v.version = t.automation_version
        WHERE (
          (e.status IN ('pending','retrying') AND e.next_attempt_at <= $2)
          OR
          (e.status IN ('claimed','running') AND e.lease_expires_at <= $2)
        )
          AND a.status NOT IN ('archived','disabled')
          AND ($5::text IS NULL OR a.tenant_id = $5)
          AND (t.scheduled_for IS NULL OR t.scheduled_for <= $2)
          AND (
            COALESCE(
              (v.definition #>> '{executionStrategy,queueTriggerEvents}')::boolean,
              false
            ) = false
            OR NOT EXISTS (
              SELECT 1
                FROM automation_trigger_event previous_trigger
               WHERE previous_trigger.automation_id = t.automation_id
                 AND previous_trigger.automation_version = t.automation_version
                 AND previous_trigger.status IN ('queued','running')
                 AND (
                   previous_trigger.created_at < t.created_at
                   OR (
                     previous_trigger.created_at = t.created_at
                     AND previous_trigger.trigger_event_id < t.trigger_event_id
                   )
                 )
            )
          )
          AND (
            e.is_fallback = true
            OR v.definition #>> '{executionStrategy,mode}' = 'parallel'
            OR NOT EXISTS (
              SELECT 1
                FROM automation_effect_execution previous
               WHERE previous.trigger_event_id = e.trigger_event_id
                 AND previous.is_fallback = false
                 AND previous.effect_order < e.effect_order
                 AND previous.status <> 'succeeded'
            )
          )
        ORDER BY e.next_attempt_at, e.created_at
        FOR UPDATE OF e SKIP LOCKED
        LIMIT $3
     ),
     claimed AS (
       UPDATE automation_effect_execution e
          SET status = 'claimed',
              lease_owner = $1,
              lease_expires_at = $2 + make_interval(secs => $4),
              heartbeat_at = $2,
              updated_at = now()
         FROM eligible
        WHERE e.effect_execution_id = eligible.effect_execution_id
       RETURNING e.*
     )
     SELECT claimed.effect_execution_id, claimed.trigger_event_id,
            claimed.effect_id, claimed.effect_order, claimed.is_fallback,
            claimed.parent_effect_execution_id,
            claimed.attempt_count, claimed.max_attempts,
            t.condition_output, t.automation_id, t.automation_version,
            a.tenant_id, a.ontology_id, a.owner_user_id,
            a.owner_security_snapshot, v.definition
       FROM claimed
       JOIN automation_trigger_event t ON t.trigger_event_id = claimed.trigger_event_id
       JOIN automation a ON a.automation_id = t.automation_id
       JOIN automation_version v
         ON v.automation_id = t.automation_id
        AND v.version = t.automation_version`,
    [input.workerId, now, limit, leaseSeconds, input.tenantId ?? null],
  );
  return result.rows;
}

function errorInfo(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const candidate = error as {
    code?: string;
    status?: number;
    statusCode?: number;
    message?: string;
  };
  const status = candidate.status ?? candidate.statusCode;
  const retryable =
    status === 408 ||
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    status === undefined;
  return {
    code: candidate.code ?? "AUTOMATION_EFFECT_FAILED",
    message: candidate.message?.slice(0, 2_000) ?? "Effect execution failed.",
    retryable,
  };
}

async function executeActionEffect(
  row: ClaimedEffect,
  effect: Extract<EffectDraft, { type: "action" }>,
  parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!effect.actionTypeId || !effect.actionApiName || !effect.definitionVersion) {
    throw Object.assign(new Error("The Action effect is not fully configured."), {
      code: "ACTION_REQUIRED",
      status: 422,
    });
  }
  const actionApiName = effect.actionApiName;
  const currentAction = await pool.query<{
    action_type_id: string;
    definition_version: number;
    definition_hash: string | null;
    is_enabled: boolean;
  }>(
    `SELECT action_type_id, definition_version, definition_hash, is_enabled
       FROM action_type
      WHERE ontology_id = $1 AND api_name = $2`,
    [row.ontology_id, actionApiName],
  );
  const action = currentAction.rows[0];
  if (
    !action ||
    action.action_type_id !== effect.actionTypeId ||
    action.is_enabled !== true
  ) {
    throw Object.assign(
      new Error("The pinned Action Type is unavailable or disabled."),
      { code: "ACTION_NOT_FOUND", status: 422 },
    );
  }
  if (
    action.definition_version !== effect.definitionVersion ||
    (effect.definitionHash !== null &&
      action.definition_hash !== effect.definitionHash)
  ) {
    throw Object.assign(
      new Error(
        "The Action Type schema changed after this automation version was activated.",
      ),
      { code: "ACTION_SCHEMA_CHANGED", status: 409 },
    );
  }
  const user = await getKeycloakAdminService().getUserById(row.owner_user_id);
  if (!isExecutableOwner(user)) {
    throw Object.assign(new Error("The automation owner is disabled or deleted."), {
      code: "OWNER_PERMISSION_DENIED",
      status: 403,
    });
  }
  const security = row.owner_security_snapshot ?? {};
  const [currentRoles, currentGroups] = await Promise.all([
    getKeycloakAdminService().listUserRealmRoles(row.owner_user_id),
    getKeycloakAdminService().listUserGroups(row.owner_user_id),
  ]);
  const idempotencyKey = `automate:${row.effect_execution_id}`;
  return withIdempotencyLock(idempotencyKey, async () => {
    const cached = await checkIdempotencyKey(
      idempotencyKey,
      actionApiName,
    );
    if (cached) return cached;
    const result = await executeAction(
      row.ontology_id,
      actionApiName,
      parameters,
      {
        executedBy: row.owner_user_id,
        tenant: row.tenant_id,
        roles: currentRoles,
        groups: currentGroups,
        subjectKind: "user",
        subjectIdentifier: row.owner_user_id,
        subjectMarkings: security.markings ?? [],
        subjectCbac: security.cbac ?? [],
        markBypass: hasRuntimeMarkingBypass(currentRoles),
      },
    );
    const output = result as unknown as Record<string, unknown>;
    await storeIdempotencyKey(
      idempotencyKey,
      actionApiName,
      result.executionId,
      output,
    );
    return output;
  });
}

async function enqueueFallback(
  row: ClaimedEffect,
  fallback: NonNullable<EffectDraft["fallbackEffect"]>,
): Promise<void> {
  await pool.query(
    `INSERT INTO automation_effect_execution (
       trigger_event_id, effect_id, parent_effect_execution_id, effect_type,
       effect_order, is_fallback, max_attempts
     ) VALUES ($1,$2,$3,$4,$5,true,$6)
     ON CONFLICT (trigger_event_id, effect_id, is_fallback) DO NOTHING`,
    [
      row.trigger_event_id,
      fallback.id,
      row.effect_execution_id,
      fallback.type,
      1_000,
      fallback.retry.enabled ? fallback.retry.maxAttempts : 1,
    ],
  );
}

async function finalizeTrigger(triggerEventId: string): Promise<void> {
  const client = await pool.connect();
  let automaticRetry:
    | {
        automationId: string;
        tenantId: string;
        ownerUserId: string;
      }
    | undefined;
  try {
    await client.query("BEGIN");
    const states = await client.query<{
      status: string;
      is_fallback: boolean;
    }>(
      `SELECT status, is_fallback
         FROM automation_effect_execution
        WHERE trigger_event_id = $1
        FOR UPDATE`,
      [triggerEventId],
    );
    if (
      states.rows.some((row) =>
        ["pending", "claimed", "running", "retrying"].includes(row.status),
      )
    ) {
      await client.query("COMMIT");
      return;
    }
    const primary = states.rows.filter((row) => !row.is_fallback);
    const succeeded = primary.filter((row) => row.status === "succeeded").length;
    const status =
      succeeded === primary.length
        ? "succeeded"
        : succeeded > 0
          ? "partially_failed"
          : "failed";
    const event = await client.query<{
      automation_id: string;
      automation_version: number;
      condition_output: Record<string, unknown>;
      definition: unknown;
    }>(
      `UPDATE automation_trigger_event t
          SET status = $2, completed_at = now()
         FROM automation_version v
        WHERE t.trigger_event_id = $1
          AND v.automation_id = t.automation_id
          AND v.version = t.automation_version
        RETURNING t.automation_id, t.automation_version,
                  t.condition_output, v.definition`,
      [triggerEventId, status],
    );
    const automationId = event.rows[0]?.automation_id;
    if (automationId) {
      const definition = AutomationDraftSchema.parse(event.rows[0].definition);
      const outcomes = await client.query<{
        status: "succeeded" | "failed" | "partially_failed";
      }>(
        `SELECT status
           FROM automation_trigger_event
          WHERE automation_id = $1
            AND status IN ('succeeded','failed','partially_failed')
            AND created_at >= now() - make_interval(
              secs => $2
            )
          ORDER BY completed_at DESC
          LIMIT 10000`,
        [automationId, definition.settings.autoMute.evaluationWindowSeconds],
      );
      if (
        shouldAutoMute({
          ...definition.settings.autoMute,
          outcomes: outcomes.rows.map((row) => row.status),
        })
      ) {
        const muted = await client.query(
          `UPDATE automation
              SET status = 'muted', muted_at = now(),
                  mute_reason = 'Automatic mute: execution failure threshold reached',
                  updated_at = now()
            WHERE automation_id = $1 AND status = 'active'`,
          [automationId],
        );
        const automation = muted.rowCount
          ? await client.query<{
          owner_user_id: string;
          ontology_id: string;
        }>(
          `SELECT owner_user_id, ontology_id FROM automation
            WHERE automation_id = $1`,
          [automationId],
          )
          : { rows: [] as Array<{ owner_user_id: string; ontology_id: string }> };
        if (automation.rows[0]) {
          await insertAutomationSystemNotifications(client, {
            definition,
            ownerUserId: automation.rows[0].owner_user_id,
            automationId,
            ontologyId: automation.rows[0].ontology_id,
            executionId: triggerEventId,
            category: "auto-muted",
            message:
              "The automation was muted after reaching its configured failure threshold.",
          });
          await appendAutomationAudit(client, {
            automationId,
            automationVersion: event.rows[0].automation_version,
            actorUserId: automation.rows[0].owner_user_id,
            eventType: "automation.auto_muted",
            details: {
              triggerEventId,
              minimumExecutions:
                definition.settings.autoMute.minimumExecutions,
              failureRateThreshold:
                definition.settings.autoMute.failureRateThreshold,
              evaluationWindowSeconds:
                definition.settings.autoMute.evaluationWindowSeconds,
            },
          });
        }
        metric("tellus_automate_auto_muted_total");
      }
      if (
        ["failed", "partially_failed"].includes(status) &&
        definition.settings.eventRetries.enabled
      ) {
        const retryableFailure = await client.query<{ retryable: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM automation_effect_execution effect
               JOIN automation_effect_attempt attempt
                 ON attempt.effect_execution_id = effect.effect_execution_id
              WHERE effect.trigger_event_id = $1
                AND effect.is_fallback = false
                AND effect.status = 'exhausted'
                AND attempt.attempt_number = effect.attempt_count
                AND attempt.retryable = true
           ) AS retryable`,
          [triggerEventId],
        );
        const automation = await client.query<{
          status: string;
          tenant_id: string;
          owner_user_id: string;
        }>(
          `SELECT status, tenant_id, owner_user_id
             FROM automation
            WHERE automation_id = $1`,
          [automationId],
        );
        if (
          retryableFailure.rows[0]?.retryable === true &&
          automation.rows[0]?.status === "active"
        ) {
          automaticRetry = {
            automationId,
            tenantId: automation.rows[0].tenant_id,
            ownerUserId: automation.rows[0].owner_user_id,
          };
        }
      }
      const completionStatus =
        status === "partially_failed" ? "partially-failed" : status;
      const children = await client.query<{
        automation_id: string;
        current_version: number;
        status: "active" | "muted";
        owner_user_id: string;
        owner_security_snapshot: Record<string, unknown>;
        delay_seconds: number;
        definition: unknown;
      }>(
        `SELECT child.automation_id, child.current_version, child.status,
                child.owner_user_id, child.owner_security_snapshot,
                dependency.delay_seconds, version.definition
           FROM automation_dependency dependency
           JOIN automation child
             ON child.automation_id = dependency.child_automation_id
            AND child.current_version = dependency.child_version
           JOIN automation_version version
             ON version.automation_id = child.automation_id
            AND version.version = child.current_version
          WHERE dependency.parent_automation_id = $1
            AND child.status IN ('active','muted')
            AND $2 = ANY(dependency.completion_statuses)`,
        [automationId, completionStatus],
      );
      for (const child of children.rows) {
        const childDefinition = AutomationDraftSchema.parse(child.definition);
        const childEvent = await client.query<{ trigger_event_id: string }>(
          `INSERT INTO automation_trigger_event (
             automation_id, automation_version, trigger_key, trigger_type,
             condition_output, status, scheduled_for,
             caused_by_trigger_event_id, execution_principal, completed_at
           ) VALUES (
             $1,$2,$3,'automation-dependency',$4::jsonb,$5,
             now() + make_interval(secs => $6),$7,$8::jsonb,
             CASE WHEN $5 = 'skipped' THEN now() ELSE NULL END
           )
           ON CONFLICT (trigger_key) DO NOTHING
           RETURNING trigger_event_id`,
          [
            child.automation_id,
            child.current_version,
            `dependency:${child.automation_id}:${child.current_version}:${triggerEventId}`,
            JSON.stringify({
              triggeredAt: new Date().toISOString(),
              parentAutomationId: automationId,
              parentAutomationVersion: event.rows[0].automation_version,
              parentTriggerEventId: triggerEventId,
              parentStatus: completionStatus,
              parentOutput: event.rows[0].condition_output,
            }),
            child.status === "muted" ? "skipped" : "queued",
            child.delay_seconds,
            triggerEventId,
            JSON.stringify({
              kind: "user",
              id: child.owner_user_id,
              security: child.owner_security_snapshot,
            }),
          ],
        );
        const childTriggerId = childEvent.rows[0]?.trigger_event_id;
        if (!childTriggerId || child.status === "muted") continue;
        for (const effect of childDefinition.effects) {
          await client.query(
            `INSERT INTO automation_effect_execution (
               trigger_event_id, effect_id, effect_type, effect_order,
               max_attempts
             ) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (trigger_event_id, effect_id, is_fallback) DO NOTHING`,
            [
              childTriggerId,
              effect.id,
              effect.type,
              effect.order,
              effect.retry.enabled ? effect.retry.maxAttempts : 1,
            ],
          );
        }
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (automaticRetry) {
    try {
      await retryTriggerEvent({
        automationId: automaticRetry.automationId,
        triggerEventId,
        tenantId: automaticRetry.tenantId,
        actorUserId: automaticRetry.ownerUserId,
        idempotencyKey: `automatic:${triggerEventId}`,
      });
      metric("tellus_automate_event_retry_total", { mode: "automatic" });
    } catch (error) {
      const candidate = error as { code?: string; message?: string };
      if (candidate.code !== "AUTOMATION_EVENT_RETRIES_EXHAUSTED") {
        console.error(
          JSON.stringify({
            type: "automate.event_retry.schedule_failed",
            triggerEventId,
            code: candidate.code,
            error: candidate.message ?? String(error),
          }),
        );
        metric("tellus_automate_event_retry_schedule_failed_total");
      }
    }
  }
}

export async function executeClaimedEffect(
  row: ClaimedEffect,
  workerId: string,
  adapter?: AutomateEffectExecutionAdapter,
): Promise<void> {
  const definition = AutomationDraftSchema.parse(row.definition);
  const effect = definition.effects.find((candidate) => candidate.id === row.effect_id)
    ?? definition.effects
      .map((candidate) => candidate.fallbackEffect)
      .find((candidate) => candidate?.id === row.effect_id);
  if (!effect) {
    await pool.query(
      `UPDATE automation_effect_execution
          SET status = 'exhausted', error_code = 'EFFECT_DEFINITION_NOT_FOUND',
              error_message = 'Pinned effect definition is missing.',
              completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
              updated_at = now()
        WHERE effect_execution_id = $1 AND lease_owner = $2`,
      [row.effect_execution_id, workerId],
    );
    await finalizeTrigger(row.trigger_event_id);
    return;
  }

  const attemptNumber = row.attempt_count + 1;
  const attemptId = crypto.randomUUID();
  const attemptKey = `automate:${row.effect_execution_id}:attempt:${attemptNumber}`;
  await pool.query(
    `WITH updated AS (
       UPDATE automation_effect_execution
          SET status = 'running', attempt_count = $3, started_at = COALESCE(started_at, now()),
              heartbeat_at = now(), updated_at = now()
        WHERE effect_execution_id = $1 AND lease_owner = $2
        RETURNING effect_execution_id
     )
     INSERT INTO automation_effect_attempt (
       attempt_id, effect_execution_id, attempt_number, status, idempotency_key
     )
     SELECT $4, effect_execution_id, $3, 'running', $5 FROM updated`,
    [row.effect_execution_id, workerId, attemptNumber, attemptId, attemptKey],
  );
  await pool.query(
    `UPDATE automation_trigger_event
        SET status = 'running', started_at = COALESCE(started_at, now())
      WHERE trigger_event_id = $1 AND status = 'queued'`,
    [row.trigger_event_id],
  );

  const stopHeartbeat = startEffectHeartbeat(
    row.effect_execution_id,
    workerId,
  );
  try {
    const effectOutputs = await previousEffectOutputs(row.trigger_event_id);
    const bindingContext = {
      conditionOutput: row.condition_output,
      automationId: row.automation_id,
      automationVersion: row.automation_version,
      triggerEventId: row.trigger_event_id,
      ownerId: row.owner_user_id,
      effectOutputs,
    };
    const parameters = effectParameters(effect, bindingContext);
    let output: Record<string, unknown>;
    if (adapter) {
      output = await adapter({
        row,
        effect,
        parameters,
        conditionOutput: row.condition_output,
        effectOutputs,
      });
    } else if (effect.type === "action") {
      output = await executeActionEffect(row, effect, parameters);
    } else if (effect.type === "function") {
      output = await executeFunctionEffect({
        ontologyId: row.ontology_id,
        ownerUserId: row.owner_user_id,
        effect,
        parameters,
        effectExecutionId: row.effect_execution_id,
        automationId: row.automation_id,
        effectId: effect.id,
      });
    } else if (effect.type === "notification") {
      output = await executeNotificationEffect({
        ontologyId: row.ontology_id,
        ownerUserId: row.owner_user_id,
        effectExecutionId: row.effect_execution_id,
        effect,
        conditionOutput: row.condition_output,
        resolveBinding: (binding) => resolveBinding(binding, bindingContext),
      });
    } else {
      throw Object.assign(
        new Error(`${effect.type} execution is not available in this vertical slice.`),
        { code: `${effect.type.toUpperCase()}_RUNTIME_UNAVAILABLE`, status: 422 },
      );
    }
    await stopHeartbeat();
    const completion = await pool.connect();
    try {
      await completion.query("BEGIN");
      const completed = await completion.query(
        `UPDATE automation_effect_execution
            SET status = 'succeeded', output = $2::jsonb, completed_at = now(),
                lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE effect_execution_id = $1 AND lease_owner = $3
          RETURNING effect_execution_id`,
        [
          row.effect_execution_id,
          JSON.stringify(output),
          workerId,
        ],
      );
      if (!completed.rowCount) throw new EffectLeaseLostError();
      await completion.query(
        `UPDATE automation_effect_attempt
            SET status = 'succeeded', completed_at = now(),
                external_execution_id = $2
          WHERE attempt_id = $1`,
        [
          attemptId,
          typeof output.executionId === "string" ? output.executionId : null,
        ],
      );
      if (row.is_fallback && row.parent_effect_execution_id) {
        await completion.query(
          `UPDATE automation_effect_execution
              SET status = 'succeeded',
                  output = COALESCE(output, '{}'::jsonb) || $2::jsonb,
                  completed_at = now(), updated_at = now()
            WHERE effect_execution_id = $1`,
          [
            row.parent_effect_execution_id,
            JSON.stringify({
              resolvedByFallbackEffectExecutionId: row.effect_execution_id,
            }),
          ],
        );
      }
      await completion.query("COMMIT");
    } catch (completionError) {
      await completion.query("ROLLBACK").catch(() => undefined);
      throw completionError;
    } finally {
      completion.release();
    }
    metric("tellus_automate_effect_execution_total", {
      effect: effect.type,
      result: "succeeded",
    });
  } catch (error) {
    await stopHeartbeat();
    if (error instanceof EffectLeaseLostError) {
      metric("tellus_automate_stale_lease_total", { work: "effect" });
      return;
    }
    const info = errorInfo(error);
    const canRetry =
      attemptNumber < row.max_attempts &&
      (info.retryable || effect.retry.retryAllFailures);
    const delay = canRetry
      ? retryDelaySeconds(effect.retry, attemptNumber)
      : 0;
    const failure = await pool.connect();
    try {
      await failure.query("BEGIN");
      const failed = await failure.query(
        `UPDATE automation_effect_execution
            SET status = CASE WHEN $2 THEN 'retrying' ELSE 'exhausted' END,
                error_code = $3, error_message = $4,
                next_attempt_at = CASE WHEN $2 THEN now() + make_interval(secs => $5) ELSE next_attempt_at END,
                completed_at = CASE WHEN $2 THEN NULL ELSE now() END,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE effect_execution_id = $1 AND lease_owner = $6`,
        [
          row.effect_execution_id,
          canRetry,
          info.code,
          info.message,
          delay,
          workerId,
        ],
      );
      if (!failed.rowCount) throw new EffectLeaseLostError();
      await failure.query(
        `UPDATE automation_effect_attempt
            SET status = 'failed', completed_at = now(), error_code = $2,
                error_message = $3, retryable = $4,
                next_retry_at = CASE WHEN $5 THEN now() + make_interval(secs => $6) ELSE NULL END
          WHERE attempt_id = $1`,
        [attemptId, info.code, info.message, info.retryable, canRetry, delay],
      );
      if (!canRetry) {
        await insertAutomationSystemNotifications(failure, {
          definition,
          ownerUserId: row.owner_user_id,
          automationId: row.automation_id,
          ontologyId: row.ontology_id,
          executionId: row.effect_execution_id,
          category: "effect-failure",
          message: info.message,
        });
      }
      await failure.query("COMMIT");
    } catch (failureError) {
      await failure.query("ROLLBACK").catch(() => undefined);
      if (failureError instanceof EffectLeaseLostError) {
        metric("tellus_automate_stale_lease_total", { work: "effect" });
        return;
      }
      throw failureError;
    } finally {
      failure.release();
    }
    if (!canRetry) {
      const fallback =
        "fallbackEffect" in effect
          ? (effect.fallbackEffect as
              | NonNullable<EffectDraft["fallbackEffect"]>
              | undefined)
          : undefined;
      if (fallback) {
        await enqueueFallback(row, fallback);
      }
      if (
        definition.executionStrategy.mode === "sequential" &&
        !fallback
      ) {
        const failedPrimaryExecutionId =
          row.is_fallback && row.parent_effect_execution_id
            ? row.parent_effect_execution_id
            : row.effect_execution_id;
        await pool.query(
          `UPDATE automation_effect_execution
              SET status = 'skipped',
                  error_code = 'PREVIOUS_EFFECT_FAILED',
                  error_message = 'A previous sequential effect exhausted its retries.',
                  completed_at = now(), updated_at = now()
            WHERE trigger_event_id = $1
              AND is_fallback = false
              AND effect_order > (
                SELECT effect_order FROM automation_effect_execution
                 WHERE effect_execution_id = $2
              )
              AND status = 'pending'`,
          [row.trigger_event_id, failedPrimaryExecutionId],
        );
      }
    }
    metric("tellus_automate_effect_execution_total", {
      effect: effect.type,
      result: canRetry ? "retrying" : "exhausted",
    });
  }
  await finalizeTrigger(row.trigger_event_id);
}

export async function runAutomateWorkerOnce(input: {
  workerId: string;
  limit?: number;
}): Promise<number> {
  const claimed = await claimAutomateEffects(input);
  await Promise.all(
    claimed.map((row) => executeClaimedEffect(row, input.workerId)),
  );
  return claimed.length;
}

let loopAbort: AbortController | null = null;

export function startAutomateRuntime(): void {
  if (loopAbort) return;
  loopAbort = new AbortController();
  const signal = loopAbort.signal;
  const workerId =
    process.env.AUTOMATE_WORKER_ID ??
    `${process.env.HOSTNAME ?? "local"}:${process.pid}:${crypto.randomUUID()}`;
  const intervalMs = Math.max(
    250,
    Number(process.env.AUTOMATE_POLL_INTERVAL_MS ?? 2_000),
  );
  const loop = async (): Promise<void> => {
    while (!signal.aborted) {
      try {
        await runAutomateSchedulerOnce();
        await runAutomateConditionEvaluatorOnce({ workerId });
        await runAutomateLiveEventsOnce();
        await runAutomateWorkerOnce({ workerId });
      } catch (error) {
        console.error(JSON.stringify({
          type: "automate.runtime.error",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  };
  void loop();
}

export function stopAutomateRuntime(): void {
  loopAbort?.abort();
  loopAbort = null;
}
