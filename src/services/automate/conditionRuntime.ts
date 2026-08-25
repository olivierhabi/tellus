import crypto from "crypto";
import type { PoolClient } from "pg";
import { pool } from "../../db";
import {
  buildSecurityFilter,
  type SecurityContext,
} from "../../middleware/securityContext";
import { compileObjectSet } from "../oss/objectSetCompiler";
import {
  aggregateObjectSet,
  loadObjectSet,
  type ExecutionContext,
} from "../oss/objectSetExecutor";
import {
  objectSetFingerprint,
  parseAggregateObjectSetRequest,
  parseLoadObjectSetRequest,
  parseObjectSet,
} from "../oss/objectSetDefinition";
import {
  makeProductionCompilerDeps,
  makeProductionExecutorDeps,
} from "../oss/productionDeps";
import { getKeycloakAdminService } from "../keycloakAdminService";
import {
  loadAuthorizedEventObject,
  type DurableEvent,
  type DurableSubscription,
} from "../oss/durableSubscriptions";
import {
  AutomationDraftSchema,
  type AutomationDraft,
  type EffectDraft,
  type ThresholdExpression,
} from "./contracts";
import { effectiveObjectSet } from "./objectCondition";
import { executeFunctionEffect } from "./effectExecutors";
import {
  hasRuntimeMarkingBypass,
  isExecutableOwner,
} from "./permissions";
import { appendAutomationAudit } from "./repository";

const DEFAULT_BATCH = 8;
const DEFAULT_LEASE_SECONDS = 120;

interface ClaimedEvaluation {
  evaluation_id: string;
  automation_id: string;
  automation_version: number;
  evaluation_key: string;
  scheduled_for: Date;
  cursor: string | null;
  examined_count: string | number;
  matched_count: string | number;
  attempt_count: number;
  max_attempts: number;
  tenant_id: string;
  ontology_id: string;
  owner_user_id: string;
  owner_security_snapshot: Record<string, unknown>;
  automation_status: "active" | "muted";
  definition: unknown;
}

function ownerSecurity(
  ownerId: string,
  snapshot: Record<string, unknown>,
): SecurityContext {
  return {
    userId: ownerId,
    markings: Array.isArray(snapshot.markings)
      ? snapshot.markings.map(String)
      : [],
    organizations: Array.isArray(snapshot.organizations)
      ? snapshot.organizations.map(String)
      : [],
    cbac: Array.isArray(snapshot.cbac) ? snapshot.cbac.map(String) : [],
    markingMode:
      snapshot.markingMode === "conjunctive" ? "conjunctive" : "disjunctive",
    systemPrincipal: false,
    markingBypass:
      Array.isArray(snapshot.roles) &&
      hasRuntimeMarkingBypass(snapshot.roles.map(String)),
  };
}

async function currentOwnerSecuritySnapshot(
  ownerUserId: string,
  snapshot: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const keycloak = getKeycloakAdminService();
  const [owner, roles] = await Promise.all([
    keycloak.getUserById(ownerUserId),
    keycloak.listUserRealmRoles(ownerUserId),
  ]);
  if (!isExecutableOwner(owner)) {
    throw Object.assign(
      new Error("The automation owner is disabled or deleted."),
      { code: "OWNER_PERMISSION_DENIED", status: 403 },
    );
  }
  return {
    ...snapshot,
    roles,
    markingBypass: hasRuntimeMarkingBypass(roles),
  };
}

async function disableForUnavailableOwner(input: {
  automationId: string;
  automationVersion: number;
  ownerUserId: string;
  source: "scheduled-evaluation" | "live-evaluation";
}): Promise<void> {
  const disabled = await pool.query(
    `UPDATE automation
        SET status = 'disabled', next_run_at = NULL, updated_at = now()
      WHERE automation_id = $1 AND status IN ('active','muted')`,
    [input.automationId],
  );
  if (!disabled.rowCount) return;
  await appendAutomationAudit(pool, {
    automationId: input.automationId,
    automationVersion: input.automationVersion,
    actorUserId: input.ownerUserId,
    eventType: "automation.disabled",
    details: {
      reason: "The automation owner is disabled or deleted.",
      source: input.source,
    },
  });
}

function publicObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !key.startsWith("__")),
  );
}

function valueHash(value: Record<string, unknown>): string {
  const entries = Object.entries(publicObject(value)).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(entries)))
    .digest("hex");
}

async function createTriggerAndEffects(
  client: PoolClient,
  input: {
    row: ClaimedEvaluation;
    definition: AutomationDraft;
    triggerKey: string;
    triggerType: string;
    output: Record<string, unknown>;
  },
): Promise<boolean> {
  const event = await client.query<{ trigger_event_id: string }>(
    `INSERT INTO automation_trigger_event (
       automation_id, automation_version, trigger_key, trigger_type,
       condition_output, status, scheduled_for, execution_principal,
       completed_at
     ) VALUES (
       $1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,
       CASE WHEN $6 = 'skipped' THEN now() ELSE NULL END
     )
     ON CONFLICT (trigger_key) DO NOTHING
     RETURNING trigger_event_id`,
    [
      input.row.automation_id,
      input.row.automation_version,
      input.triggerKey,
      input.triggerType,
      JSON.stringify(input.output),
      input.row.automation_status === "muted" ? "skipped" : "queued",
      input.row.scheduled_for,
      JSON.stringify({
        kind: "user",
        id: input.row.owner_user_id,
        security: input.row.owner_security_snapshot,
      }),
    ],
  );
  const triggerEventId = event.rows[0]?.trigger_event_id;
  if (!triggerEventId || input.row.automation_status === "muted") return false;
  for (const effect of input.definition.effects) {
    await client.query(
      `INSERT INTO automation_effect_execution (
         trigger_event_id, effect_id, effect_type, effect_order, max_attempts
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
  return true;
}

async function claimEvaluations(input: {
  workerId: string;
  limit: number;
  leaseSeconds: number;
}): Promise<ClaimedEvaluation[]> {
  const result = await pool.query<ClaimedEvaluation>(
    `WITH eligible AS (
       SELECT evaluation_id
         FROM automation_condition_evaluation
        WHERE (
          status = 'pending'
          OR (status IN ('claimed','running') AND lease_expires_at <= now())
        )
          AND scheduled_for <= now()
          AND next_attempt_at <= now()
        ORDER BY scheduled_for, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2
     ), claimed AS (
       UPDATE automation_condition_evaluation evaluation
          SET status = 'claimed',
              lease_owner = $1,
              lease_expires_at = now() + make_interval(secs => $3),
              heartbeat_at = now(),
              attempt_count = attempt_count + 1,
              started_at = COALESCE(started_at, now()),
              updated_at = now()
         FROM eligible
        WHERE evaluation.evaluation_id = eligible.evaluation_id
       RETURNING evaluation.*
     )
     SELECT claimed.*, automation.tenant_id, automation.ontology_id,
            automation.owner_user_id, automation.owner_security_snapshot,
            automation.status AS automation_status, version.definition
       FROM claimed
       JOIN automation
         ON automation.automation_id = claimed.automation_id
       JOIN automation_version version
         ON version.automation_id = claimed.automation_id
        AND version.version = claimed.automation_version
      WHERE automation.status IN ('active','muted')`,
    [input.workerId, input.limit, input.leaseSeconds],
  );
  return result.rows;
}

async function loadEvaluationPage(
  row: ClaimedEvaluation,
  definition: AutomationDraft,
): Promise<{
  data: Array<Record<string, unknown>>;
  nextPageToken: string | null;
}> {
  const condition = definition.condition;
  if (
    condition.type !== "objects-added" &&
    condition.type !== "objects-removed" &&
    condition.type !== "objects-modified" &&
    condition.type !== "run-on-all"
  ) {
    throw Object.assign(
      new Error(`Scheduled ${condition.type} evaluation is not implemented.`),
      { code: "CONDITION_RUNTIME_UNAVAILABLE" },
    );
  }
  // The effective monitored set is the base set AND the optional
  // per-condition property filter (condition.objectCondition). The SAME
  // builder is used by validation, the preview, and the membership
  // initialization/diff so runtime and preview can never diverge.
  const objectSet = parseObjectSet(effectiveObjectSet(condition));
  const security = ownerSecurity(
    row.owner_user_id,
    row.owner_security_snapshot,
  );
  const compiled = await compileObjectSet(
    objectSet,
    makeProductionCompilerDeps({
      tenant: row.tenant_id,
      ontologyRid: row.ontology_id,
      branchRid: null,
      userId: row.owner_user_id,
    }),
  );
  // A scheduled membership diff must observe one stable object-set boundary.
  // The canonical OSS executor carries its PIT identifiers in the opaque page
  // token and closes them after the final page.
  const snapshot = true;
  const executorDeps = makeProductionExecutorDeps(
    {
      securityFilter: buildSecurityFilter(security),
      branchId: null,
      ontologyId: row.ontology_id,
      userId: row.owner_user_id,
      tenant: row.tenant_id,
      markings: security.markings,
      cbac: security.cbac,
      organizations: security.organizations,
      markingBypass: security.markingBypass,
      requestId: row.evaluation_id,
      transactionId: null,
      scenarioRid: null,
    },
    {
      snapshot,
      readContexts: { transaction: null, scenario: null },
    },
  );
  const ctx: ExecutionContext = {
    ontologyRid: row.ontology_id,
    branchRid: null,
    tenant: row.tenant_id,
    userId: row.owner_user_id,
    securityFingerprint: objectSetFingerprint({
      markings: [...security.markings].sort(),
      cbac: [...security.cbac].sort(),
      organizations: [...security.organizations].sort(),
      markingBypass: security.markingBypass,
    }),
    transactionId: null,
    transactionVersion: null,
    scenarioRid: null,
    scenarioVersion: null,
    snapshot,
  };
  const request = parseLoadObjectSetRequest({
    objectSet,
    pageSize: condition.batchSize,
    pageToken: row.cursor ?? undefined,
    snapshot,
  });
  const result = await loadObjectSet(compiled, request, ctx, executorDeps);
  return { data: result.data, nextPageToken: result.nextPageToken };
}

async function processEvaluation(
  row: ClaimedEvaluation,
  workerId: string,
): Promise<void> {
  const definition = AutomationDraftSchema.parse(row.definition);
  const condition = definition.condition;
  // Membership initialization. A condition that has not established its
  // baseline runs its FIRST evaluation as a baseline regardless of the
  // evaluation key — no objects-added/removed/modified/run-on-all trigger is
  // emitted for objects that existed before the baseline boundary. After the
  // baseline completes, `initialized` flips true (below) and only subsequent
  // evaluations emit differences. This holds for activation, a new
  // automation version, a worker restart with missing state, and a
  // reconfigured condition — never an added-storm.
  const initState = await pool.query<{ state: { initialized?: boolean } }>(
    `SELECT state FROM automation_condition_state
      WHERE automation_id = $1 AND automation_version = $2`,
    [row.automation_id, row.automation_version],
  );
  const initialized = initState.rows[0]?.state?.initialized === true;
  // Only the membership-diff conditions (added/removed/modified) use the
  // baseline. run-on-all always runs on the full set every evaluation —
  // that IS its semantics — so it is never baseline-suppressed.
  const isMembershipCondition =
    condition.type === "objects-added" ||
    condition.type === "objects-removed" ||
    condition.type === "objects-modified";
  const baseline =
    isMembershipCondition &&
    (row.evaluation_key.includes("baseline:") || !initialized);
  if (condition.type === "threshold-crossed") {
    await processThresholdEvaluation(row, workerId, definition);
    return;
  }
  if (
    condition.type !== "objects-added" &&
    condition.type !== "objects-removed" &&
    condition.type !== "objects-modified" &&
    condition.type !== "run-on-all"
  ) {
    throw Object.assign(
      new Error(`Scheduled ${condition.type} evaluation is not implemented.`),
      { code: "CONDITION_RUNTIME_UNAVAILABLE" },
    );
  }

  // Track which primary keys appear in the current effective set across ALL
  // pages of this scan. Removals are computed at the end as
  // "present members not seen in this scan" — we do NOT reset `present`
  // globally first, because that clobbers the pre-scan state the
  // added/modified diff relies on and turns every evaluation into an
  // objects-added storm.
  const seenPrimaryKeys = new Set<string>();

  let current = row;
  while (true) {
    const page = await loadEvaluationPage(current, definition);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let matched = 0;
      for (const object of page.data) {
        const primaryKey = String(object.__primaryKey ?? "");
        const objectType = String(
          object.__apiName ?? condition.objectTypeApiName,
        );
        if (!primaryKey || !objectType) continue;
        seenPrimaryKeys.add(`${objectType}:${primaryKey}`);
        const previous = await client.query<{
          present: boolean;
          value_hash: string | null;
          selected_values: Record<string, unknown> | null;
        }>(
          `SELECT present, value_hash, selected_values
             FROM automation_object_membership
            WHERE automation_id = $1 AND automation_version = $2
              AND object_type_api_name = $3 AND primary_key = $4
            FOR UPDATE`,
          [
            row.automation_id,
            row.automation_version,
            objectType,
            primaryKey,
          ],
        );
        const previousRow = previous.rows[0];
        const safeObject = publicObject(object);
        const hash = valueHash(object);
        const changedProperties = previousRow?.selected_values
          ? [...new Set([
              ...Object.keys(previousRow.selected_values),
              ...Object.keys(safeObject),
            ])].filter(
              (property) =>
                JSON.stringify(previousRow.selected_values?.[property]) !==
                JSON.stringify(safeObject[property]),
            )
          : [];
        const monitoredChanged =
          condition.monitoredProperties.length === 0 ||
          changedProperties.some((property) =>
            condition.monitoredProperties.includes(property),
          );
        const triggerAdded =
          !previousRow?.present &&
          (condition.type === "objects-added" ||
            condition.alsoTriggerWhenAdded);
        const triggerModified =
          previousRow?.present === true &&
          previousRow.value_hash !== hash &&
          monitoredChanged &&
          condition.type === "objects-modified";
        const triggerAll = condition.type === "run-on-all";
        if (!baseline && (triggerAdded || triggerModified || triggerAll)) {
          const kind = triggerAdded
            ? "object-added"
            : triggerModified
              ? "object-modified"
              : "run-on-all";
          const triggered = await createTriggerAndEffects(client, {
            row,
            definition,
            triggerKey:
              `${row.evaluation_key}:${kind}:${objectType}:${primaryKey}`,
            triggerType: kind,
            output: {
              triggeredAt: new Date().toISOString(),
              objectTypeId: objectType,
              objectId: primaryKey,
              object: safeObject,
              currentValues: safeObject,
              ...(triggerModified
                ? {
                    changedProperties,
                    previousValues: previousRow?.selected_values ?? undefined,
                  }
                : {}),
            },
          });
          if (triggered) matched += 1;
        }
        await client.query(
          `INSERT INTO automation_object_membership (
             automation_id, automation_version, object_type_api_name,
             primary_key, object_rid, value_hash, selected_values, present
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,true)
           ON CONFLICT (
             automation_id, automation_version, object_type_api_name, primary_key
           ) DO UPDATE SET
             object_rid = EXCLUDED.object_rid,
             value_hash = EXCLUDED.value_hash,
             selected_values = EXCLUDED.selected_values,
             present = true,
             updated_at = now()`,
          [
            row.automation_id,
            row.automation_version,
            objectType,
            primaryKey,
            object.__rid == null ? null : String(object.__rid),
            hash,
            JSON.stringify(safeObject),
          ],
        );
      }
      await client.query(
        `UPDATE automation_condition_evaluation
            SET status = $3,
                cursor = $4,
                examined_count = examined_count + $5,
                matched_count = matched_count + $6,
                heartbeat_at = now(),
                lease_expires_at = now() + make_interval(secs => $7),
                updated_at = now()
          WHERE evaluation_id = $1 AND lease_owner = $2`,
        [
          row.evaluation_id,
          workerId,
          page.nextPageToken ? "running" : "claimed",
          page.nextPageToken,
          page.data.length,
          matched,
          DEFAULT_LEASE_SECONDS,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!page.nextPageToken) break;
    current = { ...current, cursor: page.nextPageToken };
  }

  const completion = await pool.connect();
  try {
    await completion.query("BEGIN");
    // Removals = members that are currently present but did NOT appear in
    // this scan of the effective set. Composite `objectType:primaryKey`
    // keys guard against a cross-object-type primary-key collision.
    const seenKeys = [...seenPrimaryKeys];
    const removed = await completion.query<{
      object_type_api_name: string;
      primary_key: string;
      selected_values: Record<string, unknown> | null;
    }>(
      `SELECT object_type_api_name, primary_key, selected_values
         FROM automation_object_membership
        WHERE automation_id = $1 AND automation_version = $2
          AND present = true
          AND NOT (
            (object_type_api_name || ':' || primary_key) = ANY($3::text[])
          )
        FOR UPDATE`,
      [row.automation_id, row.automation_version, seenKeys],
    );
    if (
      !baseline &&
      (condition.type === "objects-removed" ||
        condition.alsoTriggerWhenRemoved)
    ) {
      for (const object of removed.rows) {
        await createTriggerAndEffects(completion, {
          row,
          definition,
          triggerKey:
            `${row.evaluation_key}:object-removed:` +
            `${object.object_type_api_name}:${object.primary_key}`,
          triggerType: "object-removed",
          output: {
            triggeredAt: new Date().toISOString(),
            objectTypeId: object.object_type_api_name,
            objectId: object.primary_key,
            removedObject: {
              objectTypeId: object.object_type_api_name,
              objectId: object.primary_key,
            },
            previousValues: object.selected_values ?? undefined,
          },
        });
      }
    }
    // Drop the now-removed members so the next scan diffs against the
    // current set.
    await completion.query(
      `DELETE FROM automation_object_membership
        WHERE automation_id = $1 AND automation_version = $2
          AND present = true
          AND NOT (
            (object_type_api_name || ':' || primary_key) = ANY($3::text[])
          )`,
      [row.automation_id, row.automation_version, seenKeys],
    );
    await completion.query(
      `UPDATE automation_condition_evaluation
          SET status = 'succeeded', cursor = NULL, completed_at = now(),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE evaluation_id = $1 AND lease_owner = $2`,
      [row.evaluation_id, workerId],
    );
    await completion.query(
      `INSERT INTO automation_condition_state (
         automation_id, automation_version, state, last_evaluated_at
       ) VALUES ($1,$2,$3::jsonb,now())
       ON CONFLICT (automation_id, automation_version)
       DO UPDATE SET
         state = automation_condition_state.state || EXCLUDED.state,
         last_evaluated_at = now(), updated_at = now()`,
      [
        row.automation_id,
        row.automation_version,
        JSON.stringify({
          lastEvaluationId: row.evaluation_id,
          ...(baseline ? { initialized: true } : {}),
        }),
      ],
    );
    await completion.query("COMMIT");
  } catch (error) {
    await completion.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    completion.release();
  }
}

export function compareMetric(
  current: unknown,
  operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq",
  expected: unknown,
): boolean {
  if (operator === "eq") return current === expected;
  if (operator === "neq") return current !== expected;
  if (typeof current !== "number" || typeof expected !== "number") return false;
  if (operator === "gt") return current > expected;
  if (operator === "gte") return current >= expected;
  if (operator === "lt") return current < expected;
  return current <= expected;
}

export function thresholdTransitionCrossed(
  previous: boolean | null,
  current: boolean,
  direction: "rising" | "falling" | "both",
): boolean {
  return (
    previous !== null &&
    previous !== current &&
    ((current && (direction === "rising" || direction === "both")) ||
      (!current && (direction === "falling" || direction === "both")))
  );
}

export async function evaluateThresholdExpression(input: {
  expression: ThresholdExpression;
  tenantId: string;
  ontologyId: string;
  ownerUserId: string;
  ownerSecuritySnapshot: Record<string, unknown>;
  requestId: string;
}): Promise<{ result: boolean; values: Record<string, unknown> }> {
  const security = ownerSecurity(
    input.ownerUserId,
    input.ownerSecuritySnapshot,
  );
  const ctx: ExecutionContext = {
    ontologyRid: input.ontologyId,
    branchRid: null,
    tenant: input.tenantId,
    userId: input.ownerUserId,
    securityFingerprint: objectSetFingerprint({
      markings: [...security.markings].sort(),
      cbac: [...security.cbac].sort(),
      organizations: [...security.organizations].sort(),
      markingBypass: security.markingBypass,
    }),
    transactionId: null,
    scenarioRid: null,
    snapshot: false,
  };
  const executorDeps = makeProductionExecutorDeps(
    {
      securityFilter: buildSecurityFilter(security),
      branchId: null,
      ontologyId: input.ontologyId,
      userId: input.ownerUserId,
      tenant: input.tenantId,
      markings: security.markings,
      cbac: security.cbac,
      organizations: security.organizations,
      markingBypass: security.markingBypass,
      requestId: input.requestId,
    },
    {
      snapshot: false,
      readContexts: { transaction: null, scenario: null },
    },
  );
  const values: Record<string, unknown> = {};
  const evaluate = async (expression: ThresholdExpression): Promise<boolean> => {
    if (expression.kind === "group") {
      const children = await Promise.all(expression.children.map(evaluate));
      return expression.operator === "and"
        ? children.every(Boolean)
        : children.some(Boolean);
    }
    if (expression.kind === "function") {
      if (
        !expression.functionRid ||
        !expression.repositoryRid ||
        !expression.apiName ||
        !expression.branch ||
        !expression.version ||
        !expression.artifactSha256
      ) {
        throw Object.assign(
          new Error("The threshold Function row is not fully configured."),
          { code: "THRESHOLD_FUNCTION_REQUIRED", status: 422 },
        );
      }
      const parameters = Object.fromEntries(
        Object.entries(expression.parameters).map(([name, binding]) => {
          if (binding.kind !== "constant") {
            throw Object.assign(
              new Error(
                "Threshold Function parameters must use constant bindings.",
              ),
              {
                code: "THRESHOLD_FUNCTION_BINDING_UNSUPPORTED",
                status: 422,
              },
            );
          }
          return [name, binding.value];
        }),
      );
      const functionEffect: Extract<EffectDraft, { type: "function" }> = {
        id: expression.id,
        type: "function",
        name: expression.apiName,
        order: 0,
        functionRid: expression.functionRid,
        repositoryRid: expression.repositoryRid,
        apiName: expression.apiName,
        branch: expression.branch,
        version: expression.version,
        artifactSha256: expression.artifactSha256,
        autoUpgrade: false,
        timeoutSeconds: 5,
        parameters: expression.parameters,
        retry: {
          enabled: false,
          strategy: "constant",
          maxAttempts: 1,
          delaySeconds: 1,
          multiplier: 2,
          maxDelaySeconds: 1,
          jitter: { kind: "none" },
          retryAllFailures: false,
        },
      };
      const output = await executeFunctionEffect({
        ontologyId: input.ontologyId,
        ownerUserId: input.ownerUserId,
        effect: functionEffect,
        parameters,
      });
      if (typeof output.result !== "boolean") {
        throw Object.assign(
          new Error(
            `Threshold Function '${expression.apiName}' returned a non-Boolean value.`,
          ),
          { code: "THRESHOLD_FUNCTION_OUTPUT_INVALID", status: 422 },
        );
      }
      values[expression.id] = output.result;
      return output.result;
    }
    const objectSet = parseObjectSet(expression.objectSet);
    const compiled = await compileObjectSet(
      objectSet,
      makeProductionCompilerDeps({
        tenant: input.tenantId,
        ontologyRid: input.ontologyId,
        branchRid: null,
        userId: input.ownerUserId,
      }),
    );
    const request = parseAggregateObjectSetRequest({
      objectSet,
      aggregation: [
        expression.aggregation === "count"
          ? { type: "count", name: expression.id }
          : {
              type: expression.aggregation,
              field: expression.propertyApiName,
              name: expression.id,
            },
      ],
      groupBy: [],
      accuracy: "REQUIRE_ACCURATE",
    });
    const result = await aggregateObjectSet(
      compiled,
      request,
      ctx,
      executorDeps,
    );
    const value = result.data[0]?.metrics[0]?.value ?? 0;
    values[expression.id] = value;
    return compareMetric(value, expression.operator, expression.comparisonValue);
  };
  return {
    result: await evaluate(input.expression),
    values,
  };
}

async function processThresholdEvaluation(
  row: ClaimedEvaluation,
  workerId: string,
  definition: AutomationDraft,
): Promise<void> {
  if (definition.condition.type !== "threshold-crossed") return;
  const evaluated = await evaluateThresholdExpression({
    expression: definition.condition.expression,
    tenantId: row.tenant_id,
    ontologyId: row.ontology_id,
    ownerUserId: row.owner_user_id,
    ownerSecuritySnapshot: row.owner_security_snapshot,
    requestId: row.evaluation_id,
  });
  const current = evaluated.result;
  const values = evaluated.values;
  const state = await pool.query<{ state: Record<string, unknown> }>(
    `SELECT state FROM automation_condition_state
      WHERE automation_id = $1 AND automation_version = $2`,
    [row.automation_id, row.automation_version],
  );
  const previous =
    typeof state.rows[0]?.state?.thresholdPrevious === "boolean"
      ? state.rows[0].state.thresholdPrevious
      : null;
  const direction = definition.condition.direction;
  const crossed = thresholdTransitionCrossed(previous, current, direction);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (crossed) {
      await createTriggerAndEffects(client, {
        row,
        definition,
        triggerKey: `${row.evaluation_key}:threshold-crossed`,
        triggerType: "threshold-crossed",
        output: {
          triggeredAt: new Date().toISOString(),
          previousValue: previous,
          currentValue: current,
          metricValues: values,
          direction: current ? "rising" : "falling",
        },
      });
    }
    await client.query(
      `UPDATE automation_condition_state
          SET state = state || $3::jsonb, last_evaluated_at = now(),
              updated_at = now()
        WHERE automation_id = $1 AND automation_version = $2`,
      [
        row.automation_id,
        row.automation_version,
        JSON.stringify({
          thresholdPrevious: current,
          thresholdMetricValues: values,
          lastEvaluationId: row.evaluation_id,
        }),
      ],
    );
    await client.query(
      `UPDATE automation_condition_evaluation
          SET status = 'succeeded', examined_count = 1,
              matched_count = $3, completed_at = now(),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE evaluation_id = $1 AND lease_owner = $2`,
      [row.evaluation_id, workerId, crossed ? 1 : 0],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function runAutomateConditionEvaluatorOnce(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
}): Promise<number> {
  const claimed = await claimEvaluations({
    workerId: input.workerId,
    limit: input.limit ?? DEFAULT_BATCH,
    leaseSeconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
  });
  await Promise.all(
    claimed.map(async (row) => {
      const lockClient = await pool.connect();
      const lockName =
        `automate-evaluation:${row.automation_id}:${row.automation_version}`;
      let locked = false;
      try {
        const lock = await lockClient.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
          [lockName],
        );
        locked = lock.rows[0]?.acquired === true;
        if (!locked) {
          await pool.query(
            `UPDATE automation_condition_evaluation
                SET status = 'pending', lease_owner = NULL,
                    lease_expires_at = NULL, updated_at = now()
              WHERE evaluation_id = $1 AND lease_owner = $2`,
            [row.evaluation_id, input.workerId],
          );
          return;
        }
        row.owner_security_snapshot = await currentOwnerSecuritySnapshot(
          row.owner_user_id,
          row.owner_security_snapshot,
        );
        await processEvaluation(row, input.workerId);
      } catch (error) {
        const value = error as { code?: string; message?: string };
        const exhausted =
          value.code === "OWNER_PERMISSION_DENIED" ||
          row.attempt_count >= row.max_attempts;
        const retryDelaySeconds = Math.min(
          300,
          5 * 2 ** Math.max(0, row.attempt_count - 1),
        );
        await pool.query(
          `UPDATE automation_condition_evaluation
              SET status = $2, error_code = $3, error_message = $4,
                  completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
                  next_attempt_at = CASE
                    WHEN $2 = 'pending'
                    THEN now() + make_interval(secs => $5)
                    ELSE next_attempt_at
                  END,
                  lease_owner = NULL,
                  lease_expires_at = NULL, updated_at = now()
            WHERE evaluation_id = $1 AND lease_owner = $6`,
          [
            row.evaluation_id,
            exhausted ? "failed" : "pending",
            value.code ?? "CONDITION_EVALUATION_FAILED",
            value.message ?? "Condition evaluation failed.",
            retryDelaySeconds,
            input.workerId,
          ],
        );
        if (value.code === "OWNER_PERMISSION_DENIED") {
          await disableForUnavailableOwner({
            automationId: row.automation_id,
            automationVersion: row.automation_version,
            ownerUserId: row.owner_user_id,
            source: "scheduled-evaluation",
          });
        }
      } finally {
        if (locked) {
          await lockClient
            .query("SELECT pg_advisory_unlock(hashtext($1))", [lockName])
            .catch(() => undefined);
        }
        lockClient.release();
      }
    }),
  );
  return claimed.length;
}

interface LiveAutomationRow {
  automation_id: string;
  current_version: number;
  tenant_id: string;
  ontology_id: string;
  owner_user_id: string;
  owner_security_snapshot: Record<string, unknown>;
  automation_status: "active" | "muted";
  last_event_sequence: string | number;
  definition: unknown;
}

interface LiveEventRow {
  event_sequence: string | number;
  event_id: string;
  object_type_api_name: string;
  primary_key: string;
  object_rid: string | null;
  state: "ADDED_OR_UPDATED" | "REMOVED";
  object_value: Record<string, unknown> | null;
  changed_properties: string[];
  changed_link_types: string[];
}

async function processLiveAutomation(
  row: LiveAutomationRow,
  limit: number,
): Promise<number> {
  const definition = AutomationDraftSchema.parse(row.definition);
  const condition = definition.condition;
  if (
    condition.type !== "objects-added" &&
    condition.type !== "objects-removed" &&
    condition.type !== "objects-modified" &&
    condition.type !== "run-on-all"
  ) {
    return 0;
  }
  const client = await pool.connect();
  const lockName = `automate-live:${row.automation_id}:${row.current_version}`;
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [lockName],
    );
    locked = lock.rows[0]?.acquired === true;
    if (!locked) return 0;
    const retained = await client.query<{ oldest: string | number | null }>(
      `SELECT min(event_sequence) AS oldest
         FROM object_set_event
        WHERE tenant_id = $1 AND ontology_id = $2`,
      [row.tenant_id, row.ontology_id],
    );
    const oldest = Number(retained.rows[0]?.oldest ?? 0);
    const cursor = Number(row.last_event_sequence);
    if (oldest > 0 && cursor < oldest - 1) {
      await client.query("BEGIN");
      await client.query(
        `UPDATE automation_condition_state
            SET state = state || '{"initialized":false}'::jsonb,
                updated_at = now()
          WHERE automation_id = $1 AND automation_version = $2`,
        [row.automation_id, row.current_version],
      );
      await client.query(
        `INSERT INTO automation_condition_evaluation (
           automation_id, automation_version, evaluation_key, scheduled_for
         ) VALUES ($1,$2,$3,now())
         ON CONFLICT (evaluation_key) DO NOTHING`,
        [
          row.automation_id,
          row.current_version,
          `live-recovery-baseline:${row.automation_id}:` +
            `${row.current_version}:${oldest}`,
        ],
      );
      await client.query("COMMIT");
      return 0;
    }
    const events = await client.query<LiveEventRow>(
      `SELECT event_sequence, event_id, object_type_api_name, primary_key,
              object_rid, state, object_value, changed_properties,
              changed_link_types
         FROM object_set_event
        WHERE tenant_id = $1 AND ontology_id = $2
          AND event_sequence > $3
          AND object_type_api_name = $4
          AND (
            branch_id IS NULL
            OR branch_id IN (
              SELECT ob.branch_id::text FROM ontology_branch ob
               WHERE ob.ontology_id = $2
                 AND (ob.parent_branch_id IS NULL OR ob.status = 'MERGED')
            )
          )
          AND transaction_id IS NULL
          AND scenario_rid IS NULL
        ORDER BY event_sequence
        LIMIT $5`,
      [
        row.tenant_id,
        row.ontology_id,
        cursor,
        condition.objectTypeApiName,
        limit,
      ],
    );
    const security = ownerSecurity(
      row.owner_user_id,
      row.owner_security_snapshot,
    );
    const subscription: DurableSubscription = {
      id: `automation:${row.automation_id}:${row.current_version}`,
      tenantId: row.tenant_id,
      ontologyId: row.ontology_id,
      ownerUserId: row.owner_user_id,
      branchId: null,
      transactionId: null,
      scenarioRid: null,
      objectSet: parseObjectSet(condition.objectSet),
      fingerprint: objectSetFingerprint(condition.objectSet),
      propertySet: [],
      referenceSet: [],
      dependencyTypes: [condition.objectTypeApiName],
      dependencyProperties: condition.monitoredProperties,
      lastAcknowledgedSequence: cursor,
    };
    let processed = 0;
    for (const eventRow of events.rows) {
      const event: DurableEvent = {
        sequence: Number(eventRow.event_sequence),
        eventId: eventRow.event_id,
        objectType: eventRow.object_type_api_name,
        primaryKey: eventRow.primary_key,
        objectRid: eventRow.object_rid,
        state: eventRow.state,
        objectValue: eventRow.object_value,
        changedProperties: eventRow.changed_properties ?? [],
        changedLinkTypes: eventRow.changed_link_types ?? [],
      };
      const authorizedObject = await loadAuthorizedEventObject({
        subscription,
        event,
        security,
      });
      await client.query("BEGIN");
      try {
        const previous = await client.query<{
          present: boolean;
          selected_values: Record<string, unknown> | null;
        }>(
          `SELECT present, selected_values
             FROM automation_object_membership
            WHERE automation_id = $1 AND automation_version = $2
              AND object_type_api_name = $3 AND primary_key = $4
            FOR UPDATE`,
          [
            row.automation_id,
            row.current_version,
            event.objectType,
            event.primaryKey,
          ],
        );
        const previousRow = previous.rows[0];
        // The object-change event pipeline does not populate
        // `object_set_event.changed_properties` (it is `{}` — the documented
        // "event richness" limitation) AND the event's `object_value` is
        // unreliable (it frequently omits/stales property values, e.g. a
        // province-change event carries `fullName=""`). For an objects-modified
        // condition with monitored properties, compute the changed-property
        // diff from the PRIOR membership `selected_values` vs the
        // `authorizedObject` (loaded fresh from the datastore — the TRUE
        // current values), mirroring the scheduled evaluator's diff. This
        // detects a monitored-property change WITHOUT false-positiving on
        // an unmonitored change whose event payload omits the monitored value.
        if (
          condition.type === "objects-modified" &&
          condition.monitoredProperties.length > 0 &&
          event.changedProperties.length === 0 &&
          previousRow?.present === true &&
          authorizedObject
        ) {
          const prevVals = previousRow.selected_values ?? {};
          const newVals = publicObject(authorizedObject) as Record<
            string,
            unknown
          >;
          const diff = condition.monitoredProperties.filter(
            (p) =>
              JSON.stringify(prevVals[p] ?? null) !==
              JSON.stringify(newVals[p] ?? null),
          );
          if (diff.length > 0) event.changedProperties = diff;
        }
        const removed =
          event.state === "REMOVED" ||
          (event.state === "ADDED_OR_UPDATED" && !authorizedObject);
        const added = !removed && previousRow?.present !== true;
        const relevantModification =
          !removed &&
          previousRow?.present === true &&
          (condition.monitoredProperties.length === 0 ||
            event.changedProperties.some((property) =>
              condition.monitoredProperties.includes(property),
            ));
        const shouldTrigger =
          (added &&
            (condition.type === "objects-added" ||
              condition.alsoTriggerWhenAdded)) ||
          (removed &&
            previousRow?.present === true &&
            (condition.type === "objects-removed" ||
              condition.alsoTriggerWhenRemoved)) ||
          (relevantModification && condition.type === "objects-modified");
        if (shouldTrigger) {
          const triggerType = added
            ? "object-added"
            : removed
              ? "object-removed"
              : "object-modified";
          const object = authorizedObject
            ? publicObject(authorizedObject)
            : undefined;
          const triggerRow: ClaimedEvaluation = {
            evaluation_id: event.eventId,
            automation_id: row.automation_id,
            automation_version: row.current_version,
            evaluation_key: `live:${event.eventId}`,
            scheduled_for: new Date(),
            cursor: null,
            examined_count: 1,
            matched_count: 0,
            attempt_count: 1,
            max_attempts: 1,
            tenant_id: row.tenant_id,
            ontology_id: row.ontology_id,
            owner_user_id: row.owner_user_id,
            owner_security_snapshot: row.owner_security_snapshot,
            automation_status: row.automation_status,
            definition: row.definition,
          };
          await createTriggerAndEffects(client, {
            row: triggerRow,
            definition,
            triggerKey:
              `live:${row.automation_id}:${row.current_version}:` +
              `${event.eventId}:${triggerType}`,
            triggerType,
            output: {
              triggeredAt: new Date().toISOString(),
              objectTypeId: event.objectType,
              objectId: event.primaryKey,
              ...(object
                ? { object, currentValues: object }
                : {
                    removedObject: {
                      objectTypeId: event.objectType,
                      objectId: event.primaryKey,
                    },
                  }),
              ...(triggerType === "object-modified"
                ? {
                    changedProperties: event.changedProperties,
                    previousValues:
                      previousRow?.selected_values ?? undefined,
                  }
                : {}),
            },
          });
        }
        if (removed) {
          await client.query(
            `DELETE FROM automation_object_membership
              WHERE automation_id = $1 AND automation_version = $2
                AND object_type_api_name = $3 AND primary_key = $4`,
            [
              row.automation_id,
              row.current_version,
              event.objectType,
              event.primaryKey,
            ],
          );
        } else if (authorizedObject) {
          const safe = publicObject(authorizedObject);
          await client.query(
            `INSERT INTO automation_object_membership (
               automation_id, automation_version, object_type_api_name,
               primary_key, object_rid, value_hash, selected_values, present,
               last_event_sequence
             ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,true,$8)
             ON CONFLICT (
               automation_id, automation_version, object_type_api_name,
               primary_key
             ) DO UPDATE SET
               object_rid = EXCLUDED.object_rid,
               value_hash = EXCLUDED.value_hash,
               selected_values = EXCLUDED.selected_values,
               present = true,
               last_event_sequence = EXCLUDED.last_event_sequence,
               updated_at = now()`,
            [
              row.automation_id,
              row.current_version,
              event.objectType,
              event.primaryKey,
              event.objectRid,
              valueHash(authorizedObject),
              JSON.stringify(safe),
              event.sequence,
            ],
          );
        }
        await client.query(
          `UPDATE automation_condition_state
              SET last_event_sequence = GREATEST(
                    COALESCE(last_event_sequence, 0), $3
                  ),
                  updated_at = now()
            WHERE automation_id = $1 AND automation_version = $2`,
          [row.automation_id, row.current_version, event.sequence],
        );
        await client.query("COMMIT");
        processed += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    return processed;
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [lockName])
        .catch(() => undefined);
    }
    client.release();
  }
}

export async function runAutomateLiveEventsOnce(
  limitPerAutomation = 100,
): Promise<number> {
  const result = await pool.query<LiveAutomationRow>(
    `SELECT automation.automation_id, automation.current_version,
            automation.tenant_id, automation.ontology_id,
            automation.owner_user_id, automation.owner_security_snapshot,
            automation.status AS automation_status,
            state.last_event_sequence, version.definition
       FROM automation
       JOIN automation_version version
         ON version.automation_id = automation.automation_id
        AND version.version = automation.current_version
       JOIN automation_condition_state state
         ON state.automation_id = automation.automation_id
        AND state.automation_version = automation.current_version
      WHERE automation.status IN ('active','muted')
        AND version.definition #>> '{condition,evaluationMode}' = 'live'
        AND state.state ->> 'initialized' = 'true'
      ORDER BY state.updated_at
      LIMIT 100`,
  );
  let processed = 0;
  for (const row of result.rows) {
    try {
      row.owner_security_snapshot = await currentOwnerSecuritySnapshot(
        row.owner_user_id,
        row.owner_security_snapshot,
      );
      processed += await processLiveAutomation(row, limitPerAutomation);
    } catch (error) {
      const candidate = error as { code?: string };
      if (candidate.code !== "OWNER_PERMISSION_DENIED") throw error;
      await disableForUnavailableOwner({
        automationId: row.automation_id,
        automationVersion: row.current_version,
        ownerUserId: row.owner_user_id,
        source: "live-evaluation",
      });
    }
  }
  return processed;
}
