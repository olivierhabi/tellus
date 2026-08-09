import crypto from "crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "../../db";
import { canonicalJson } from "../audit/canonicalJson";
import {
  AUTOMATION_SCHEMA_VERSION,
  AutomationDraftSchema,
  type ActionEffectRepin,
  type AutomationDraft,
  type AutomationStatus,
  type PrincipalReference,
} from "./contracts";
import { nextScheduleOccurrence } from "./schedule";
import { validateAutomationForActivation } from "./validation";
import { conditionFingerprint } from "./objectCondition";
import { getKeycloakAdminService } from "../keycloakAdminService";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export class AutomationServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AutomationServiceError";
  }
}

export interface AutomationRecord {
  automationId: string;
  rid: string;
  tenantId: string;
  ontologyId: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  createdBy: string;
  status: AutomationStatus;
  currentVersion: number | null;
  draftDefinition: AutomationDraft;
  draftRevision: number;
  nextRunAt: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  mutedAt: string | null;
  muteReason: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AutomationRow {
  automation_id: string;
  rid: string;
  tenant_id: string;
  ontology_id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  created_by: string;
  status: AutomationStatus;
  current_version: number | null;
  draft_definition: unknown;
  draft_revision: string | number;
  next_run_at: Date | string | null;
  activated_at: Date | string | null;
  paused_at: Date | string | null;
  muted_at: Date | string | null;
  mute_reason: string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: AutomationRow): AutomationRecord {
  return {
    automationId: row.automation_id,
    rid: row.rid,
    tenantId: row.tenant_id,
    ontologyId: row.ontology_id,
    name: row.name,
    description: row.description,
    ownerUserId: row.owner_user_id,
    createdBy: row.created_by,
    status: row.status,
    currentVersion: row.current_version,
    draftDefinition: AutomationDraftSchema.parse(row.draft_definition),
    draftRevision: Number(row.draft_revision),
    nextRunAt: iso(row.next_run_at),
    activatedAt: iso(row.activated_at),
    pausedAt: iso(row.paused_at),
    mutedAt: iso(row.muted_at),
    muteReason: row.mute_reason,
    archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export function canManageAutomation(input: {
  ownerUserId: string;
  administrators: PrincipalReference[];
  actorUserId: string;
  actorGroupIds?: string[];
}): boolean {
  if (input.ownerUserId === input.actorUserId) return true;
  if (
    input.administrators.some(
      (administrator) =>
        administrator.kind === "user" &&
        administrator.id === input.actorUserId,
    )
  ) {
    return true;
  }
  const actorGroups = new Set(input.actorGroupIds ?? []);
  return input.administrators.some(
    (administrator) =>
      administrator.kind === "group" && actorGroups.has(administrator.id),
  );
}

export function defaultAutomationDraft(
  ontologyId: string,
  owner: PrincipalReference,
  now = new Date(),
): AutomationDraft {
  return AutomationDraftSchema.parse({
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    ontologyId,
    name: "Untitled automation",
    condition: {
      type: "time",
      evaluationMode: "scheduled",
      schedule: {
        kind: "interval",
        frequency: "daily",
        every: 1,
        timezone: "UTC",
        timeOfDay: { hour: 9, minute: 0 },
        anchorAt: now.toISOString(),
        missedRunPolicy: "fire-once",
      },
    },
    effects: [],
    settings: {
      eventRetries: { enabled: false, maxRetries: 3, intervalSeconds: 3_600 },
      administrators: [],
      informationNotificationAudience: "owner-and-recipients",
      effectFailureNotificationAudience: "owner-and-recipients",
      autoMute: {
        enabled: true,
        minimumExecutions: 30,
        failureRateThreshold: 0.8,
        evaluationWindowSeconds: 15_552_000,
      },
      historyScope: "owner",
      retainHistoryDays: 180,
    },
    executionStrategy: { mode: "parallel", queueTriggerEvents: true },
    owner,
  });
}

export async function createDraft(input: {
  tenantId: string;
  ontologyId: string;
  actorUserId: string;
  actorDisplayName?: string;
  securitySnapshot?: Record<string, unknown>;
  definition?: unknown;
}): Promise<AutomationRecord> {
  const owner: PrincipalReference = {
    kind: "user",
    id: input.actorUserId,
    displayName: input.actorDisplayName,
  };
  const definition = input.definition === undefined
    ? defaultAutomationDraft(input.ontologyId, owner)
    : AutomationDraftSchema.parse(input.definition);
  if (definition.ontologyId !== input.ontologyId) {
    throw new AutomationServiceError(
      "AUTOMATION_DEFINITION_INVALID",
      "The definition ontology does not match the requested ontology.",
    );
  }
  const automationId = crypto.randomUUID();
  const rid = `ri.automate.main.automation.${automationId}`;
  const result = await pool.query<AutomationRow>(
    `INSERT INTO automation (
       automation_id, rid, tenant_id, ontology_id, name, description,
       owner_user_id, created_by, draft_definition, owner_security_snapshot
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8::jsonb,$9::jsonb)
     RETURNING *`,
    [
      automationId,
      rid,
      input.tenantId,
      input.ontologyId,
      definition.name,
      definition.description ?? null,
      input.actorUserId,
      JSON.stringify(definition),
      JSON.stringify({
        ...(input.securitySnapshot ?? {}),
        capturedAt: new Date().toISOString(),
      }),
    ],
  );
  return mapRow(result.rows[0]);
}

export async function listAutomations(input: {
  tenantId: string;
  actorUserId: string;
  ontologyId?: string;
  limit: number;
  before?: string;
}): Promise<AutomationRecord[]> {
  const actorGroupIds = await getKeycloakAdminService()
    .listUserGroupReferences(input.actorUserId)
    .then((groups) => groups.map((group) => group.id))
    .catch(() => [] as string[]);
  const values: unknown[] = [
    input.tenantId,
    input.actorUserId,
    input.limit,
    actorGroupIds,
  ];
  const where = [
    "tenant_id = $1",
    `(owner_user_id = $2 OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(
           COALESCE(draft_definition #> '{settings,administrators}', '[]'::jsonb)
         ) administrator
       WHERE (
         administrator ->> 'kind' = 'user'
         AND administrator ->> 'id' = $2
       ) OR (
         administrator ->> 'kind' = 'group'
         AND administrator ->> 'id' = ANY($4::text[])
       )
     ))`,
  ];
  if (input.ontologyId) {
    values.push(input.ontologyId);
    where.push(`ontology_id = $${values.length}`);
  }
  if (input.before) {
    values.push(input.before);
    where.push(`updated_at < $${values.length}::timestamptz`);
  }
  const result = await pool.query<AutomationRow>(
    `SELECT * FROM automation
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, automation_id
      LIMIT $3`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function getAutomation(
  automationId: string,
  tenantId: string,
  actorUserId: string,
  db: Queryable = pool,
): Promise<AutomationRecord> {
  const result = await db.query<AutomationRow>(
    `SELECT * FROM automation
      WHERE automation_id = $1 AND tenant_id = $2`,
    [automationId, tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AutomationServiceError(
      "AUTOMATION_NOT_FOUND",
      "Automation not found.",
      404,
    );
  }
  const administrators =
    AutomationDraftSchema.parse(row.draft_definition).settings.administrators;
  if (
    canManageAutomation({
      ownerUserId: row.owner_user_id,
      administrators,
      actorUserId,
    })
  ) {
    return mapRow(row);
  }
  const groupAdministratorIds = new Set(
    administrators
      .filter((administrator) => administrator.kind === "group")
      .map((administrator) => administrator.id),
  );
  if (groupAdministratorIds.size > 0) {
    const actorGroups =
      await getKeycloakAdminService().listUserGroupReferences(actorUserId);
    if (
      canManageAutomation({
        ownerUserId: row.owner_user_id,
        administrators,
        actorUserId,
        actorGroupIds: actorGroups.map((group) => group.id),
      })
    ) {
      return mapRow(row);
    }
  }
  throw new AutomationServiceError(
    "AUTOMATION_NOT_FOUND",
    "Automation not found.",
    404,
  );
}

export async function updateDraft(input: {
  automationId: string;
  tenantId: string;
  actorUserId: string;
  expectedRevision: number;
  definition: unknown;
}): Promise<AutomationRecord> {
  const definition = AutomationDraftSchema.parse(input.definition);
  const current = await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  if (current.status === "archived") {
    throw new AutomationServiceError(
      "AUTOMATION_NOT_EXECUTABLE",
      "Archived automations cannot be edited.",
      409,
    );
  }
  const result = await pool.query<AutomationRow>(
    `UPDATE automation
        SET draft_definition = $4::jsonb,
            name = $5,
            description = $6,
            draft_revision = draft_revision + 1,
            updated_at = now()
      WHERE automation_id = $1
        AND tenant_id = $2
        AND draft_revision = $3
        AND status <> 'archived'
      RETURNING *`,
    [
      input.automationId,
      input.tenantId,
      input.expectedRevision,
      JSON.stringify(definition),
      definition.name,
      definition.description ?? null,
    ],
  );
  if (result.rows[0]) return mapRow(result.rows[0]);
  await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  throw new AutomationServiceError(
    "AUTOMATION_VERSION_CONFLICT",
    "The draft was updated elsewhere. Reload it before saving again.",
    409,
  );
}

/**
 * Move validated action-effect pins onto their resolved definition
 * version+hash, in-place on the draft, matching by effect id. Handles
 * fallback effect chains (a repin may target a fallback action effect).
 */
function applyEffectRepins(
  definition: AutomationDraft,
  repins: ActionEffectRepin[],
): void {
  const byId = new Map(repins.map((pin) => [pin.effectId, pin]));
  const walk = (
    effect: AutomationDraft["effects"][number] | undefined,
  ): void => {
    if (!effect) return;
    const pin = byId.get(effect.id);
    if (pin && effect.type === "action") {
      effect.definitionVersion = pin.definitionVersion;
      effect.definitionHash = pin.definitionHash;
    }
    if (effect.fallbackEffect) walk(effect.fallbackEffect);
  };
  for (const effect of definition.effects) walk(effect);
}

function hashDefinition(definition: AutomationDraft): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(definition))
    .digest("hex");
}

export async function activateAutomation(input: {
  automationId: string;
  tenantId: string;
  actorUserId: string;
  expectedRevision: number;
  idempotencyKey: string;
}): Promise<AutomationRecord> {
  const authorizedRecord = await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`automate-activate:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`],
    );
    const requestHash = crypto
      .createHash("sha256")
      .update(
        canonicalJson({
          automationId: input.automationId,
          revision: input.expectedRevision,
        }),
      )
      .digest("hex");
    const prior = await client.query<{
      request_hash: string;
      automation_id: string;
    }>(
      `SELECT request_hash, automation_id
         FROM automation_idempotency
        WHERE tenant_id = $1 AND owner_user_id = $2
          AND idempotency_key = $3 AND expires_at > now()`,
      [input.tenantId, input.actorUserId, input.idempotencyKey],
    );
    if (prior.rows[0]) {
      if (
        prior.rows[0].request_hash !== requestHash ||
        prior.rows[0].automation_id !== input.automationId
      ) {
        throw new AutomationServiceError(
          "IDEMPOTENCY_KEY_REUSED",
          "The Idempotency-Key was already used for a different request.",
          409,
        );
      }
      await client.query("COMMIT");
      return authorizedRecord;
    }
    const locked = await client.query<AutomationRow>(
      `SELECT * FROM automation
        WHERE automation_id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [input.automationId, input.tenantId],
    );
    const current = locked.rows[0] ? mapRow(locked.rows[0]) : authorizedRecord;
    if (current.draftRevision !== input.expectedRevision) {
      throw new AutomationServiceError(
        "AUTOMATION_VERSION_CONFLICT",
        "The draft changed before activation.",
        409,
      );
    }
    if (current.status === "archived") {
      throw new AutomationServiceError(
        "AUTOMATION_NOT_EXECUTABLE",
        "Archived automations cannot be activated.",
        409,
      );
    }
    const validation = await validateAutomationForActivation(
      client,
      current.draftDefinition,
      current.automationId,
      current.tenantId,
    );
    if (!validation.valid || !validation.normalizedDraft) {
      throw new AutomationServiceError(
        "AUTOMATION_DEFINITION_INVALID",
        "Automation activation validation failed.",
        422,
        { issues: validation.issues },
      );
    }
    const definition = validation.normalizedDraft;
    // Apply validated pin rewrites BEFORE the definition hash + version
    // insert so the ACTIVATED version carries the re-pinned effect — this
    // keeps execution + retry deterministic on the resolved definition.
    if (validation.repins && validation.repins.length > 0) {
      applyEffectRepins(definition, validation.repins);
    }
    const nextVersion = (current.currentVersion ?? 0) + 1;
    const definitionHash = hashDefinition(definition);
    // Idempotent activation: if this exact normalized definition was already
    // activated (byte-identical definition hash), reuse that version instead
    // of inserting a duplicate row — re-activating an unchanged automation
    // must be a no-op success, not a 23505 unique violation.
    const reused = await client.query<{ version: number }>(
      `SELECT version FROM automation_version
        WHERE automation_id = $1 AND definition_hash = $2`,
      [current.automationId, definitionHash],
    );
    const reusedVersion = reused.rows[0]?.version ?? null;
    const activatedVersion = reusedVersion ?? nextVersion;
    if (reusedVersion === null) {
      await client.query(
        `INSERT INTO automation_version (
           automation_id, version, schema_version, definition, definition_hash, created_by
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [
          current.automationId,
          nextVersion,
          definition.schemaVersion,
          JSON.stringify(definition),
          definitionHash,
          input.actorUserId,
        ],
      );
      if (validation.repins && validation.repins.length > 0) {
        for (const pin of validation.repins) {
          await appendAutomationAudit(client, {
            automationId: current.automationId,
            automationVersion: nextVersion,
            actorUserId: input.actorUserId,
            eventType:
              pin.kind === "upgraded"
                ? "AUTOMATION_EFFECT_PIN_UPGRADED"
                : "AUTOMATION_EFFECT_PIN_REFRESHED",
            details: {
              effectId: pin.effectId,
              actionTypeId: pin.actionTypeId,
              actionApiName: pin.actionApiName,
              previousDefinitionVersion: pin.previousDefinitionVersion,
              definitionVersion: pin.definitionVersion,
              definitionHash: pin.definitionHash,
              changes: pin.changes ?? [],
            },
          });
        }
      }
    }
    let nextRunAt: Date | null = null;
    if ("schedule" in definition.condition && definition.condition.schedule) {
      nextRunAt = nextScheduleOccurrence(definition.condition.schedule, new Date());
    }
    if (reusedVersion === null) {
      await client.query(
        `DELETE FROM automation_dependency WHERE child_automation_id = $1`,
        [current.automationId],
      );
    if (definition.condition.type === "automation-dependency") {
      await client.query(
        `INSERT INTO automation_dependency (
           child_automation_id, parent_automation_id, child_version,
           delay_seconds, completion_statuses
         ) VALUES ($1,$2,$3,$4,$5::text[])`,
        [
          current.automationId,
          definition.condition.parentAutomationId,
          nextVersion,
          definition.condition.delaySeconds,
          definition.condition.completionStatuses,
        ],
      );
    }
    const cond = definition.condition;
    // Narrow to the object-set condition union member (or null) so TS can
    // prove `evaluationMode`/`objectSet`/`objectCondition` exist below.
    const objectSetCond =
      cond.type === "objects-added" ||
      cond.type === "objects-removed" ||
      cond.type === "objects-modified" ||
      cond.type === "run-on-all"
        ? cond
        : null;
    const isObjectSetCondition = objectSetCond !== null;
    // Membership-diff conditions (added/removed/modified) use the baseline +
    // copy-forward semantics. run-on-all always runs on the full set every
    // evaluation — it carries no membership-diff — so it is always ready.
    const isMembershipCondition =
      cond.type === "objects-added" ||
      cond.type === "objects-removed" ||
      cond.type === "objects-modified";
    const liveObjectCondition =
      objectSetCond !== null && objectSetCond.evaluationMode === "live";
    // Deterministic fingerprint of the normalized effective condition
    // (objectSet AND objectCondition + event + monitored + mode). Used to
    // decide copy-forward vs rebaseline on this version bump.
    const nextFingerprint = objectSetCond
      ? conditionFingerprint(objectSetCond)
      : null;
    // Prior version's membership state — only a version that completed its
    // baseline (initialized) with the same fingerprint may be copied forward.
    const priorState = nextVersion > 1
      ? await client.query<{
          state: { initialized?: boolean; condition_fingerprint?: string };
        }>(
          `SELECT state FROM automation_condition_state
            WHERE automation_id = $1 AND automation_version = $2`,
          [current.automationId, nextVersion - 1],
        )
      : null;
    const priorFingerprint =
      priorState?.rows[0]?.state?.condition_fingerprint ?? null;
    const priorInitialized = priorState?.rows[0]?.state?.initialized === true;
    // Semantically identical condition (same fingerprint) + a ready prior
    // baseline → preserve membership so a metadata-only edit does NOT
    // replay every object. A changed condition always rebaselines.
    const preserveMembership =
      isMembershipCondition &&
      nextFingerprint !== null &&
      priorInitialized &&
      priorFingerprint === nextFingerprint;
    const eventCursor = liveObjectCondition
      ? await client.query<{ cursor: string | number }>(
          `SELECT COALESCE(max(event_sequence), 0) AS cursor
             FROM object_set_event
            WHERE tenant_id = $1 AND ontology_id = $2`,
          [current.tenantId, current.ontologyId],
        )
      : null;
    await client.query(
      `INSERT INTO automation_condition_state (
         automation_id, automation_version, state, last_event_sequence
       ) VALUES ($1,$2,$3::jsonb,$4)`,
      [
        current.automationId,
        nextVersion,
        JSON.stringify({
          // Non-membership-diff conditions (time/threshold/dependency/
          // run-on-all) carry no membership baseline → always ready.
          // Membership conditions start initializing (baseline runs first)
          // unless membership is copied forward from an identical,
          // already-initialized prior version.
          initialized: !isMembershipCondition || preserveMembership,
          status: !isMembershipCondition || preserveMembership
            ? "ready"
            : "initializing",
          ...(nextFingerprint
            ? { condition_fingerprint: nextFingerprint }
            : {}),
          ...(preserveMembership
            ? { initialized_at: new Date().toISOString() }
            : {}),
        }),
        eventCursor ? Number(eventCursor.rows[0]?.cursor ?? 0) : null,
      ],
    );
    if (preserveMembership) {
      // Copy the prior ready baseline forward so no object is replayed.
      await client.query(
        `INSERT INTO automation_object_membership (
           automation_id, automation_version, object_type_api_name,
           primary_key, object_rid, value_hash, selected_values, present,
           last_event_sequence, first_seen_at, updated_at
         )
         SELECT $1, $2, object_type_api_name, primary_key, object_rid,
                value_hash, selected_values, present, last_event_sequence,
                first_seen_at, now()
           FROM automation_object_membership
          WHERE automation_id = $1 AND automation_version = $2 - 1`,
        [current.automationId, nextVersion],
      );
      await appendAutomationAudit(client, {
        automationId: current.automationId,
        automationVersion: nextVersion,
        actorUserId: input.actorUserId,
        eventType: "automation.membership.copy-forward",
        details: {
          conditionFingerprint: nextFingerprint,
          fromVersion: nextVersion - 1,
        },
      });
    }
    // An object-set condition that needs a baseline gets one durable,
    // single-row baseline evaluation (claimed via SKIP LOCKED — one owner).
    // Scheduled conditions use a scheduled-baseline; live conditions a
    // live-baseline. Both suppress the trigger storm for pre-existing
    // objects. A rebaseline after a changed condition uses the same path.
    if (isMembershipCondition && !preserveMembership) {
      const baselineKey = liveObjectCondition
        ? `live-baseline:${current.automationId}:${nextVersion}`
        : `scheduled-baseline:${current.automationId}:${nextVersion}`;
      await client.query(
        `INSERT INTO automation_condition_evaluation (
           automation_id, automation_version, evaluation_key, scheduled_for
         ) VALUES ($1,$2,$3,now())
         ON CONFLICT (evaluation_key) DO NOTHING`,
        [current.automationId, nextVersion, baselineKey],
      );
      if (nextVersion > 1) {
        await appendAutomationAudit(client, {
          automationId: current.automationId,
          automationVersion: nextVersion,
          actorUserId: input.actorUserId,
          eventType: "automation.membership.rebaseline",
          details: {
            conditionFingerprint: nextFingerprint,
            priorFingerprint,
          },
        });
      }
    }
    }
    const updated = await client.query<AutomationRow>(
      `UPDATE automation
          SET status = 'active',
              current_version = $2,
              next_run_at = $3,
              activated_at = now(),
              paused_at = NULL,
              muted_at = NULL,
              mute_reason = NULL,
              updated_at = now()
        WHERE automation_id = $1
        RETURNING *`,
      [current.automationId, activatedVersion, nextRunAt],
    );
    await appendAutomationAudit(client, {
      automationId: current.automationId,
      automationVersion: activatedVersion,
      actorUserId: input.actorUserId,
      eventType: "automation.activated",
      details: {
        definitionHash,
        ...(reusedVersion !== null ? { reusedVersion } : {}),
      },
    });
    const responseRecord = mapRow(updated.rows[0]);
    await client.query(
      `INSERT INTO automation_idempotency (
         tenant_id, owner_user_id, idempotency_key, request_hash,
         automation_id, response
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        input.tenantId,
        input.actorUserId,
        input.idempotencyKey,
        requestHash,
        input.automationId,
        JSON.stringify(responseRecord),
      ],
    );
    await client.query("COMMIT");
    return responseRecord;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getManualExecutionOptions(input: {
  automationId: string;
  tenantId: string;
  actorUserId: string;
}): Promise<{
  automationId: string;
  version: number;
  effects: Array<{ id: string; name: string; type: string; order: number }>;
}> {
  // Apply the same authorization checks as the execute path: getAutomation
  // enforces tenant + owner/administrator access, throwing 404 for missing or
  // inaccessible automations without leaking existence.
  const record = await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  if (record.status !== "active" || record.currentVersion == null) {
    throw new AutomationServiceError(
      "AUTOMATION_NOT_EXECUTABLE",
      "Only an active automation can be manually executed.",
      409,
    );
  }
  const version = await pool.query<{ definition: unknown }>(
    `SELECT definition FROM automation_version
      WHERE automation_id = $1 AND version = $2`,
    [input.automationId, record.currentVersion],
  );
  const definition = AutomationDraftSchema.parse(version.rows[0]?.definition);
  return {
    automationId: input.automationId,
    version: record.currentVersion,
    // The executable effects are the active immutable definition's effects —
    // never the draft — so a draft edit after activation can never produce a
    // phantom/missing/misnamed effect in the execute dialog.
    effects: definition.effects
      .map((effect) => ({
        id: effect.id,
        name: effect.name,
        type: effect.type,
        order: effect.order,
      }))
      .sort((a, b) => a.order - b.order),
  };
}

export async function executeAutomationManually(input: {
  automationId: string;
  tenantId: string;
  actorUserId: string;
  idempotencyKey: string;
  sendCompletionNotification: boolean;
  selectedEffectIds: string[];
  securitySnapshot: Record<string, unknown>;
  requestId?: string;
  /**
   * The active automation version the caller rendered options from, fetched
   * from `GET /automations/:id/manual-execution-options`. The execute path
   * rejects with 409 AUTOMATION_VERSION_STALE when this no longer matches the
   * current active version, so a draft republish can never be executed
   * against a stale effect list the user never saw.
   */
  expectedVersion: number;
}): Promise<{ triggerEventId: string; reused: boolean }> {
  await getAutomation(input.automationId, input.tenantId, input.actorUserId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`automate-manual:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`],
    );
    const requestHash = crypto
      .createHash("sha256")
      .update(canonicalJson({
        operation: "manual-execution",
        automationId: input.automationId,
        sendCompletionNotification: input.sendCompletionNotification,
        selectedEffectIds: [...input.selectedEffectIds].sort(),
      }))
      .digest("hex");
    const prior = await client.query<{
      request_hash: string;
      automation_id: string;
      response: { triggerEventId?: unknown } | null;
    }>(
      `SELECT request_hash, automation_id, response
         FROM automation_idempotency
        WHERE tenant_id = $1 AND owner_user_id = $2
          AND idempotency_key = $3 AND expires_at > now()`,
      [input.tenantId, input.actorUserId, input.idempotencyKey],
    );
    if (prior.rows[0]) {
      const existing = prior.rows[0];
      if (
        existing.request_hash !== requestHash ||
        existing.automation_id !== input.automationId ||
        typeof existing.response?.triggerEventId !== "string"
      ) {
        throw new AutomationServiceError(
          "IDEMPOTENCY_KEY_REUSED",
          "The Idempotency-Key was already used for a different request.",
          409,
        );
      }
      await client.query("COMMIT");
      return { triggerEventId: existing.response.triggerEventId, reused: true };
    }

    const locked = await client.query<{
      status: AutomationStatus;
      current_version: number | null;
    }>(
      `SELECT status, current_version
         FROM automation
        WHERE automation_id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [input.automationId, input.tenantId],
    );
    const automation = locked.rows[0];
    if (!automation || automation.status !== "active" || automation.current_version === null) {
      throw new AutomationServiceError(
        "AUTOMATION_NOT_EXECUTABLE",
        "Only an active automation can be manually executed.",
        409,
      );
    }
    if (input.expectedVersion !== automation.current_version) {
      throw new AutomationServiceError(
        "AUTOMATION_VERSION_STALE",
        "The automation was republished. Refresh manual execution options.",
        409,
        {
          expectedVersion: input.expectedVersion,
          activeVersion: automation.current_version,
        },
      );
    }
    const version = await client.query<{ definition: unknown }>(
      `SELECT definition FROM automation_version
        WHERE automation_id = $1 AND version = $2`,
      [input.automationId, automation.current_version],
    );
    const definition = AutomationDraftSchema.parse(version.rows[0]?.definition);
    const selectedEffectIds = new Set(input.selectedEffectIds);
    const unknownEffectIds = input.selectedEffectIds.filter(
      (effectId) => !definition.effects.some((effect) => effect.id === effectId),
    );
    if (unknownEffectIds.length > 0) {
      throw new AutomationServiceError(
        "AUTOMATION_EFFECT_NOT_FOUND",
        "One or more selected effects do not exist in the active automation version.",
        400,
        { effectIds: unknownEffectIds },
      );
    }
    const now = new Date().toISOString();
    const triggerKey =
      `manual:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`;
    const inserted = await client.query<{ trigger_event_id: string }>(
      `INSERT INTO automation_trigger_event (
         automation_id, automation_version, trigger_key, trigger_type,
         condition_output, status, scheduled_for, execution_principal
       ) VALUES ($1,$2,$3,'manual',$4::jsonb,'queued',now(),$5::jsonb)
       RETURNING trigger_event_id`,
      [
        input.automationId,
        automation.current_version,
        triggerKey,
        JSON.stringify({
          triggeredAt: now,
          __manualExecution: {
            requestedByUserId: input.actorUserId,
            sendCompletionNotification: input.sendCompletionNotification,
          },
        }),
        JSON.stringify({
          kind: "user",
          id: input.actorUserId,
          security: input.securitySnapshot,
        }),
      ],
    );
    const triggerEventId = inserted.rows[0].trigger_event_id;
    for (const effect of definition.effects.filter((item) => selectedEffectIds.has(item.id))) {
      await client.query(
        `INSERT INTO automation_effect_execution (
           trigger_event_id, effect_id, effect_type, effect_order, max_attempts
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          triggerEventId,
          effect.id,
          effect.type,
          effect.order,
          effect.retry.enabled ? effect.retry.maxAttempts : 1,
        ],
      );
    }
    const response = { triggerEventId, reused: false };
    await client.query(
      `INSERT INTO automation_idempotency (
         tenant_id, owner_user_id, idempotency_key, request_hash,
         automation_id, response
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        input.tenantId,
        input.actorUserId,
        input.idempotencyKey,
        requestHash,
        input.automationId,
        JSON.stringify(response),
      ],
    );
    await appendAutomationAudit(client, {
      automationId: input.automationId,
      automationVersion: automation.current_version,
      actorUserId: input.actorUserId,
      eventType: "automation.manual_execution_created",
      requestId: input.requestId,
      details: {
        triggerEventId,
        sendCompletionNotification: input.sendCompletionNotification,
        selectedEffectIds: input.selectedEffectIds,
      },
    });
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listExecutionHistory(input: {
  automationId: string;
  tenantId: string;
  actorUserId: string;
  limit: number;
  before?: string;
}): Promise<Array<Record<string, unknown>>> {
  await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  const values: unknown[] = [input.automationId, input.limit];
  const beforeClause = input.before
    ? "AND t.created_at < $3::timestamptz"
    : "";
  if (input.before) values.push(input.before);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT t.trigger_event_id AS "triggerEventId",
            t.automation_version AS "automationVersion",
            t.trigger_type AS "triggerType",
            t.condition_output AS "conditionOutput",
            t.status,
            t.scheduled_for AS "scheduledFor",
            t.caused_by_trigger_event_id AS "causedByTriggerEventId",
            t.retry_of_trigger_event_id AS "retryOfTriggerEventId",
            t.execution_principal AS "executionPrincipal",
            t.error_code AS "errorCode",
            t.error_message AS "errorMessage",
            t.created_at AS "createdAt",
            t.started_at AS "startedAt",
            t.completed_at AS "completedAt",
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'effectExecutionId', e.effect_execution_id,
                  'effectId', e.effect_id,
                  'effectType', e.effect_type,
                  'order', e.effect_order,
                  'isFallback', e.is_fallback,
                  'status', e.status,
                  'attemptCount', e.attempt_count,
                  'output', e.output,
                  'errorCode', e.error_code,
                  'errorMessage', e.error_message,
                  'startedAt', e.started_at,
                  'completedAt', e.completed_at,
                  'attempts', COALESCE((
                    SELECT jsonb_agg(
                      jsonb_build_object(
                        'attemptNumber', attempt.attempt_number,
                        'status', attempt.status,
                        'externalExecutionId', attempt.external_execution_id,
                        'errorCode', attempt.error_code,
                        'errorMessage', attempt.error_message,
                        'retryable', attempt.retryable,
                        'nextRetryAt', attempt.next_retry_at,
                        'startedAt', attempt.started_at,
                        'completedAt', attempt.completed_at
                      ) ORDER BY attempt.attempt_number
                    )
                      FROM automation_effect_attempt attempt
                     WHERE attempt.effect_execution_id =
                           e.effect_execution_id
                  ), '[]'::jsonb)
                ) ORDER BY e.effect_order, e.created_at
              ) FILTER (WHERE e.effect_execution_id IS NOT NULL),
              '[]'::jsonb
            ) AS effects
       FROM automation_trigger_event t
       LEFT JOIN automation_effect_execution e
         ON e.trigger_event_id = t.trigger_event_id
      WHERE t.automation_id = $1
        ${beforeClause}
      GROUP BY t.trigger_event_id
      ORDER BY t.created_at DESC, t.trigger_event_id
      LIMIT $2`,
    values,
  );
  return result.rows;
}

export async function getExecutionDetails(input: {
  automationId: string;
  triggerEventId: string;
  tenantId: string;
  actorUserId: string;
}): Promise<Record<string, unknown>> {
  await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  const result = await pool.query<Record<string, unknown>>(
    `SELECT trigger.trigger_event_id AS "triggerEventId",
            trigger.automation_version AS "automationVersion",
            trigger.trigger_type AS "triggerType",
            trigger.condition_output AS "conditionOutput",
            trigger.status, trigger.scheduled_for AS "scheduledFor",
            trigger.caused_by_trigger_event_id AS "causedByTriggerEventId",
            trigger.retry_of_trigger_event_id AS "retryOfTriggerEventId",
            trigger.execution_principal AS "executionPrincipal",
            trigger.error_code AS "errorCode",
            trigger.error_message AS "errorMessage",
            trigger.created_at AS "createdAt",
            trigger.started_at AS "startedAt",
            trigger.completed_at AS "completedAt",
            COALESCE(jsonb_agg(
              jsonb_build_object(
                'effectExecutionId', effect.effect_execution_id,
                'effectId', effect.effect_id,
                'effectType', effect.effect_type,
                'order', effect.effect_order,
                'isFallback', effect.is_fallback,
                'parentEffectExecutionId', effect.parent_effect_execution_id,
                'status', effect.status,
                'input', effect.input,
                'output', effect.output,
                'errorCode', effect.error_code,
                'errorMessage', effect.error_message,
                'attempts', COALESCE((
                  SELECT jsonb_agg(to_jsonb(attempt) - 'idempotency_key'
                                   ORDER BY attempt.attempt_number)
                    FROM automation_effect_attempt attempt
                   WHERE attempt.effect_execution_id =
                         effect.effect_execution_id
                ), '[]'::jsonb)
              ) ORDER BY effect.effect_order, effect.created_at
            ) FILTER (WHERE effect.effect_execution_id IS NOT NULL),
            '[]'::jsonb) AS effects
       FROM automation_trigger_event trigger
       LEFT JOIN automation_effect_execution effect
         ON effect.trigger_event_id = trigger.trigger_event_id
      WHERE trigger.automation_id = $1 AND trigger.trigger_event_id = $2
      GROUP BY trigger.trigger_event_id`,
    [input.automationId, input.triggerEventId],
  );
  if (!result.rows[0]) {
    throw new AutomationServiceError(
      "AUTOMATION_EXECUTION_NOT_FOUND",
      "Execution not found.",
      404,
    );
  }
  return result.rows[0];
}

export async function listConditionEvaluations(input: {
  automationId: string;
  tenantId: string;
  actorUserId: string;
  limit: number;
}): Promise<Array<Record<string, unknown>>> {
  await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  const result = await pool.query<Record<string, unknown>>(
    `SELECT evaluation_id AS "evaluationId",
            automation_version AS "automationVersion",
            scheduled_for AS "scheduledFor", status, examined_count AS "examinedCount",
            matched_count AS "matchedCount", error_code AS "errorCode",
            error_message AS "errorMessage", started_at AS "startedAt",
            completed_at AS "completedAt", created_at AS "createdAt"
       FROM automation_condition_evaluation
      WHERE automation_id = $1
      ORDER BY created_at DESC, evaluation_id
      LIMIT $2`,
    [input.automationId, input.limit],
  );
  return result.rows;
}

export async function listAutomationAudit(input: {
  automationId: string;
  tenantId: string;
  actorUserId: string;
  limit: number;
}): Promise<Array<Record<string, unknown>>> {
  await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  const result = await pool.query<Record<string, unknown>>(
    `SELECT audit_event_id AS "auditEventId", event_id AS "eventId",
            automation_version AS "automationVersion",
            actor_user_id AS "actorUserId", event_type AS "eventType",
            outcome, request_id AS "requestId", details,
            created_at AS "createdAt"
       FROM automation_audit_event
      WHERE automation_id = $1
      ORDER BY created_at DESC, audit_event_id
      LIMIT $2`,
    [input.automationId, input.limit],
  );
  return result.rows;
}

export async function retryTriggerEvent(input: {
  automationId: string;
  triggerEventId: string;
  tenantId: string;
  actorUserId: string;
  idempotencyKey: string;
}): Promise<{ triggerEventId: string; reused: boolean }> {
  await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = await client.query<{
      automation_version: number;
      condition_output: Record<string, unknown>;
      execution_principal: Record<string, unknown>;
      status: string;
      definition: unknown;
    }>(
      `SELECT trigger.automation_version, trigger.condition_output,
              trigger.execution_principal, trigger.status, version.definition
         FROM automation_trigger_event trigger
         JOIN automation_version version
           ON version.automation_id = trigger.automation_id
          AND version.version = trigger.automation_version
        WHERE trigger.trigger_event_id = $1
          AND trigger.automation_id = $2
        FOR UPDATE OF trigger`,
      [input.triggerEventId, input.automationId],
    );
    const row = source.rows[0];
    if (!row || !["failed", "partially_failed"].includes(row.status)) {
      throw new AutomationServiceError(
        "AUTOMATION_EXECUTION_NOT_RETRYABLE",
        "Only failed or partially failed trigger events can be retried.",
        409,
      );
    }
    const definition = AutomationDraftSchema.parse(row.definition);
    if (!definition.settings.eventRetries.enabled) {
      throw new AutomationServiceError(
        "AUTOMATION_EVENT_RETRIES_DISABLED",
        "Event retries are disabled for this automation version.",
        409,
      );
    }
    const retryCount = await client.query<{ count: string | number }>(
      `WITH RECURSIVE ancestors AS (
         SELECT trigger_event_id, retry_of_trigger_event_id
           FROM automation_trigger_event
          WHERE trigger_event_id = $1
         UNION ALL
         SELECT parent.trigger_event_id, parent.retry_of_trigger_event_id
           FROM automation_trigger_event parent
           JOIN ancestors child
             ON parent.trigger_event_id = child.retry_of_trigger_event_id
       ),
       root AS (
         SELECT trigger_event_id
           FROM ancestors
          WHERE retry_of_trigger_event_id IS NULL
          LIMIT 1
       ),
       retry_tree AS (
         SELECT trigger.trigger_event_id
           FROM automation_trigger_event trigger
           JOIN root ON root.trigger_event_id = trigger.trigger_event_id
         UNION ALL
         SELECT child.trigger_event_id
           FROM automation_trigger_event child
           JOIN retry_tree parent
             ON child.retry_of_trigger_event_id = parent.trigger_event_id
       )
       SELECT GREATEST(count(*) - 1, 0) AS count FROM retry_tree`,
      [input.triggerEventId],
    );
    if (
      Number(retryCount.rows[0]?.count ?? 0) >=
      definition.settings.eventRetries.maxRetries
    ) {
      throw new AutomationServiceError(
        "AUTOMATION_EVENT_RETRIES_EXHAUSTED",
        "The configured event retry limit has been reached.",
        409,
      );
    }
    const triggerKey =
      `event-retry:${input.triggerEventId}:${input.idempotencyKey}`;
    const inserted = await client.query<{ trigger_event_id: string }>(
      `INSERT INTO automation_trigger_event (
         automation_id, automation_version, trigger_key, trigger_type,
         condition_output, status, scheduled_for, retry_of_trigger_event_id,
         execution_principal
       ) VALUES (
         $1,$2,$3,'event-retry',$4::jsonb,'queued',
         now() + make_interval(secs => $5),$6,$7::jsonb
       )
       ON CONFLICT (trigger_key) DO NOTHING
       RETURNING trigger_event_id`,
      [
        input.automationId,
        row.automation_version,
        triggerKey,
        JSON.stringify(row.condition_output),
        definition.settings.eventRetries.intervalSeconds,
        input.triggerEventId,
        JSON.stringify(row.execution_principal),
      ],
    );
    let retryTriggerId = inserted.rows[0]?.trigger_event_id;
    const reused = !retryTriggerId;
    if (!retryTriggerId) {
      const existing = await client.query<{ trigger_event_id: string }>(
        `SELECT trigger_event_id FROM automation_trigger_event
          WHERE trigger_key = $1`,
        [triggerKey],
      );
      retryTriggerId = existing.rows[0]!.trigger_event_id;
    }
    if (!reused) {
      const priorEffects = await client.query<{
        effect_id: string;
        effect_type: string;
        effect_order: number;
        max_attempts: number;
        status: string;
        output: unknown;
      }>(
        `SELECT effect_id, effect_type, effect_order, max_attempts,
                status, output
           FROM automation_effect_execution
          WHERE trigger_event_id = $1
            AND is_fallback = false
          ORDER BY effect_order`,
        [input.triggerEventId],
      );
      for (const effect of priorEffects.rows) {
        const reusedSuccess = effect.status === "succeeded";
        await client.query(
          `INSERT INTO automation_effect_execution (
             trigger_event_id, effect_id, effect_type, effect_order,
             max_attempts, status, output, completed_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7::jsonb,
             CASE WHEN $6 = 'succeeded' THEN now() ELSE NULL END
           )`,
          [
            retryTriggerId,
            effect.effect_id,
            effect.effect_type,
            effect.effect_order,
            effect.max_attempts,
            reusedSuccess ? "succeeded" : "pending",
            reusedSuccess ? JSON.stringify(effect.output ?? null) : null,
          ],
        );
      }
      await appendAutomationAudit(client, {
        automationId: input.automationId,
        automationVersion: row.automation_version,
        actorUserId: input.actorUserId,
        eventType: "automation.event_retry_created",
        details: {
          sourceTriggerEventId: input.triggerEventId,
          retryTriggerEventId: retryTriggerId,
          reusedSuccessfulEffectIds: priorEffects.rows
            .filter((effect) => effect.status === "succeeded")
            .map((effect) => effect.effect_id),
        },
      });
    }
    await client.query("COMMIT");
    return { triggerEventId: retryTriggerId, reused };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelTriggerEvent(input: {
  automationId: string;
  triggerEventId: string;
  tenantId: string;
  actorUserId: string;
}): Promise<void> {
  await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the trigger row first so cancellation and worker claiming
    // serialize on the same row. A worker claiming an effect of this trigger
    // blocks here until cancellation decides; cancellation that runs first
    // flips the trigger to 'cancelled'/'cancelling' and the worker's claim
    // query excludes cancelled/cancelling triggers.
    const trigger = await client.query<{
      status: string;
      condition_output: Record<string, unknown>;
      automation_version: number | null;
    }>(
      `SELECT status, condition_output, automation_version
         FROM automation_trigger_event
        WHERE trigger_event_id = $1 AND automation_id = $2
        FOR UPDATE`,
      [input.triggerEventId, input.automationId],
    );
    if (!trigger.rows[0]) {
      throw new AutomationServiceError(
        "AUTOMATION_EXECUTION_NOT_FOUND",
        "The trigger event does not exist.",
        404,
      );
    }
    const triggerStatus = trigger.rows[0].status;
    if (triggerStatus !== "queued" && triggerStatus !== "running") {
      // Already terminal (succeeded/failed/partially_failed/cancelled/skipped)
      // or already 'cancelling'. There is nothing to cancel.
      throw new AutomationServiceError(
        "AUTOMATION_EXECUTION_NOT_CANCELLABLE",
        "The trigger event is not cancellable.",
        409,
      );
    }
    // Lock the effect rows and recheck their states under the lock.
    const effects = await client.query<{ status: string }>(
      `SELECT status FROM automation_effect_execution
        WHERE trigger_event_id = $1
        FOR UPDATE`,
      [input.triggerEventId],
    );
    const inFlight = effects.rows.some((row) =>
      ["claimed", "running"].includes(row.status),
    );
    const cancelPendingEffects = () =>
      client.query(
        `UPDATE automation_effect_execution
            SET status = 'cancelled', completed_at = now(), updated_at = now()
          WHERE trigger_event_id = $1 AND status IN ('pending','retrying')`,
        [input.triggerEventId],
      );
    if (inFlight) {
      // An effect is already claimed/running and the canonical runtime cannot
      // interrupt it. Transition the trigger to 'cancelling' (compare-and-set
      // against the locked status) so finalization completes it as 'cancelled'
      // once the in-flight effect settles, and cancel the still-pending/
      // retrying effects now. The final state is never 'cancelled' with an
      // effect still executing: it is 'cancelling' until finalization flips it.
      const cancelling = await client.query(
        `UPDATE automation_trigger_event
            SET status = 'cancelling'
          WHERE trigger_event_id = $1
            AND automation_id = $2
            AND status IN ('queued','running')`,
        [input.triggerEventId, input.automationId],
      );
      if (!cancelling.rowCount) {
        // The status changed under us despite the lock — impossible for a
        // concurrent writer, but fail closed rather than corrupt state.
        throw new AutomationServiceError(
          "AUTOMATION_EXECUTION_NOT_CANCELLABLE",
          "The trigger event is not cancellable.",
          409,
        );
      }
      await cancelPendingEffects();
      await appendAutomationAudit(client, {
        automationId: input.automationId,
        automationVersion: trigger.rows[0].automation_version,
        actorUserId: input.actorUserId,
        eventType: "automation.execution_cancelling",
        details: { triggerEventId: input.triggerEventId },
      });
      await client.query("COMMIT");
      return;
    }
    // No effect is in flight: cancel the trigger atomically (compare-and-set)
    // and cancel the pending/retrying effects in the same transaction.
    const event = await client.query(
      `UPDATE automation_trigger_event
          SET status = 'cancelled', completed_at = now()
        WHERE trigger_event_id = $1
          AND automation_id = $2
          AND status IN ('queued','running')
        RETURNING trigger_event_id`,
      [input.triggerEventId, input.automationId],
    );
    if (!event.rowCount) {
      throw new AutomationServiceError(
        "AUTOMATION_EXECUTION_NOT_CANCELLABLE",
        "The trigger event is not cancellable.",
        409,
      );
    }
    await cancelPendingEffects();
    // Create a completion notification for a cancelled manual execution when
    // the caller opted in, mirroring the finalization path for other outcomes.
    const manual = trigger.rows[0].condition_output?.__manualExecution as
      | { requestedByUserId?: unknown; sendCompletionNotification?: unknown }
      | undefined;
    if (
      manual?.sendCompletionNotification === true &&
      typeof manual.requestedByUserId === "string"
    ) {
      const ontology = await client.query<{ ontology_id: string }>(
        `SELECT ontology_id FROM automation WHERE automation_id = $1`,
        [input.automationId],
      );
      const ontologyId = ontology.rows[0]?.ontology_id;
      if (ontologyId) {
        await client.query(
          `INSERT INTO notification_inbox (
             recipient_user_id, template_id, template_parameters, channel,
             action_type_api_name, execution_id, ontology_id
           ) VALUES ($1,'automate.manual-execution-complete',$2::jsonb,
                     'in_app','tellus-automate',$3,$4)`,
          [
            manual.requestedByUserId,
            JSON.stringify({
              automationId: input.automationId,
              triggerEventId: input.triggerEventId,
              status: "cancelled",
              message: "Manual automation execution completed with status: cancelled.",
            }),
            input.triggerEventId,
            ontologyId,
          ],
        );
      }
    }
    await appendAutomationAudit(client, {
      automationId: input.automationId,
      automationVersion: trigger.rows[0].automation_version,
      actorUserId: input.actorUserId,
      eventType: "automation.execution_cancelled",
      details: { triggerEventId: input.triggerEventId },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const LEGAL_TRANSITIONS: Record<AutomationStatus, AutomationStatus[]> = {
  draft: ["active", "archived"],
  active: ["paused", "muted", "disabled", "archived"],
  paused: ["active", "archived"],
  muted: ["active", "paused", "archived"],
  disabled: ["active", "archived"],
  archived: [],
};

export function canTransitionAutomation(
  from: AutomationStatus,
  to: AutomationStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export async function transitionAutomation(input: {
  automationId: string;
  tenantId: string;
  actorUserId: string;
  target: AutomationStatus;
  reason?: string;
}): Promise<AutomationRecord> {
  const current = await getAutomation(
    input.automationId,
    input.tenantId,
    input.actorUserId,
  );
  if (!canTransitionAutomation(current.status, input.target)) {
    throw new AutomationServiceError(
      "AUTOMATION_LIFECYCLE_TRANSITION_INVALID",
      `Cannot transition an automation from ${current.status} to ${input.target}.`,
      409,
    );
  }
  if (input.target === "active" && current.currentVersion === null) {
    throw new AutomationServiceError(
      "AUTOMATION_NOT_EXECUTABLE",
      "A draft must be activated before it can be resumed.",
      409,
    );
  }
  const schedule =
    "schedule" in current.draftDefinition.condition
      ? current.draftDefinition.condition.schedule
      : undefined;
  const nextRunAt =
    input.target === "active" && schedule
      ? nextScheduleOccurrence(schedule, new Date())
      : input.target === "muted"
        ? current.nextRunAt
        : null;
  const result = await pool.query<AutomationRow>(
    `UPDATE automation
        SET status = $3,
            next_run_at = $4,
            paused_at = CASE WHEN $3 = 'paused' THEN now() ELSE NULL END,
            muted_at = CASE WHEN $3 = 'muted' THEN now() ELSE NULL END,
            mute_reason = CASE WHEN $3 = 'muted' THEN $5 ELSE NULL END,
            archived_at = CASE WHEN $3 = 'archived' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE automation_id = $1 AND tenant_id = $2
      RETURNING *`,
    [
      input.automationId,
      input.tenantId,
      input.target,
      nextRunAt,
      input.reason ?? null,
    ],
  );
  if (input.target === "archived") {
    await pool.query(
      `WITH cancelled_effects AS (
         UPDATE automation_effect_execution effect
            SET status = 'cancelled', completed_at = now(), updated_at = now()
           FROM automation_trigger_event trigger
          WHERE trigger.automation_id = $1
            AND effect.trigger_event_id = trigger.trigger_event_id
            AND effect.status IN ('pending','retrying')
         RETURNING effect.trigger_event_id
       )
       UPDATE automation_trigger_event trigger
          SET status = 'cancelled', completed_at = now()
        WHERE trigger.automation_id = $1
          AND trigger.status = 'queued'
          AND (
            EXISTS (
              SELECT 1 FROM cancelled_effects cancelled
               WHERE cancelled.trigger_event_id = trigger.trigger_event_id
            )
            OR NOT EXISTS (
              SELECT 1 FROM automation_effect_execution effect
               WHERE effect.trigger_event_id = trigger.trigger_event_id
            )
          )`,
      [input.automationId],
    );
  }
  await appendAutomationAudit(pool, {
    automationId: input.automationId,
    automationVersion: current.currentVersion,
    actorUserId: input.actorUserId,
    eventType:
      input.target === "active" && current.status === "paused"
        ? "automation.resumed"
        : input.target === "active" && current.status === "muted"
          ? "automation.unmuted"
          : `automation.${input.target}`,
    details: input.reason ? { reason: input.reason } : {},
  });
  return mapRow(result.rows[0]);
}

export async function appendAutomationAudit(
  db: Queryable,
  input: {
    automationId: string;
    automationVersion: number | null;
    actorUserId: string;
    eventType: string;
    outcome?: "success" | "denied" | "failed";
    requestId?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO automation_audit_event (
       event_id, automation_id, automation_version, actor_user_id,
       event_type, outcome, request_id, details
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      crypto.randomUUID(),
      input.automationId,
      input.automationVersion,
      input.actorUserId,
      input.eventType,
      input.outcome ?? "success",
      input.requestId ?? null,
      JSON.stringify(input.details ?? {}),
    ],
  );
}
