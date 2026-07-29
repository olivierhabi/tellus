import crypto from "node:crypto";
import { query } from "../../db";
import type { SecurityContext } from "../../middleware/securityContext";
import { buildSecurityFilter } from "../../middleware/securityContext";
import { eventBus } from "../../websocket/eventBus";
import { compileObjectSet } from "./objectSetCompiler";
import type { ObjectSet } from "./objectSetDefinition";
import { objectSetFingerprint } from "./objectSetDefinition";
import { loadObjectSet } from "./objectSetExecutor";
import {
  makeProductionCompilerDeps,
  makeProductionExecutorDeps,
} from "./productionDeps";
import { resolveReadContexts } from "./readContext";
import { recordOssV2AuditBestEffort } from "./audit";
import { setGauge } from "../funnel/metrics";

const MAX_PER_USER = Number(
  process.env.TELLUS_MAX_OBJECTSET_SUBSCRIPTIONS ?? 100,
);
const MAX_PER_TENANT = Number(
  process.env.TELLUS_MAX_TENANT_OBJECTSET_SUBSCRIPTIONS ?? 10_000,
);
const REPLAY_BATCH = 500;
const EVENT_RETENTION_SECONDS = Math.max(
  60,
  Number(process.env.TELLUS_OBJECTSET_EVENT_RETENTION_SECONDS ?? 86_400),
);
let bridgeAttached = false;
let retentionTimer: NodeJS.Timeout | null = null;

export interface DurableSubscription {
  id: string;
  tenantId: string;
  ontologyId: string;
  ownerUserId: string;
  branchId: string | null;
  transactionId: string | null;
  scenarioRid: string | null;
  objectSet: ObjectSet;
  fingerprint: string;
  propertySet: string[];
  referenceSet: string[];
  dependencyTypes: string[];
  dependencyProperties: string[];
  lastAcknowledgedSequence: number;
}

export interface DurableEvent {
  sequence: number;
  eventId: string;
  objectType: string;
  primaryKey: string;
  objectRid: string | null;
  state: "ADDED_OR_UPDATED" | "REMOVED";
  objectValue: Record<string, unknown> | null;
  changedProperties: string[];
  changedLinkTypes: string[];
}

export class SubscriptionProtocolError extends Error {
  constructor(
    public readonly errorName: string,
    message: string,
    public readonly parameters: Record<string, unknown> = {},
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "SubscriptionProtocolError";
  }
}

interface SubscriptionCursorPayload {
  subscriptionId: string;
  tenantId: string;
  userId: string;
  sequence: number;
  createdAt: number;
}

function subscriptionCursorSecret(): string {
  return (
    process.env.TELLUS_SUBSCRIPTION_CURSOR_SECRET ??
    process.env.TELLUS_PAGE_TOKEN_SECRET ??
    "tellus-dev-subscription-cursor-secret"
  );
}

function signSubscriptionCursor(body: string): string {
  return crypto
    .createHmac("sha256", subscriptionCursorSecret())
    .update(body)
    .digest("base64url");
}

export function createSubscriptionCursor(input: {
  subscriptionId: string;
  tenantId: string;
  userId: string;
  sequence: number;
}): string {
  const payload: SubscriptionCursorPayload = {
    ...input,
    createdAt: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${body}.${signSubscriptionCursor(body)}`;
}

export function decodeSubscriptionCursor(
  token: string,
  expected: {
    subscriptionId: string;
    tenantId: string;
    userId: string;
  },
): number {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    throw new SubscriptionProtocolError(
      "InvalidSubscriptionCursor",
      "Invalid subscription cursor format.",
    );
  }
  const body = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1));
  const expectedSignature = Buffer.from(signSubscriptionCursor(body));
  if (
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(signature, expectedSignature)
  ) {
    throw new SubscriptionProtocolError(
      "InvalidSubscriptionCursor",
      "Subscription cursor failed integrity validation.",
    );
  }
  let payload: SubscriptionCursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new SubscriptionProtocolError(
      "InvalidSubscriptionCursor",
      "Invalid subscription cursor format.",
    );
  }
  if (
    payload.subscriptionId !== expected.subscriptionId ||
    payload.tenantId !== expected.tenantId ||
    payload.userId !== expected.userId
  ) {
    throw new SubscriptionProtocolError(
      "InvalidSubscriptionCursor",
      "Subscription cursor belongs to a different principal or subscription.",
    );
  }
  if (
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 0 ||
    !Number.isSafeInteger(payload.createdAt) ||
    Date.now() - payload.createdAt > EVENT_RETENTION_SECONDS * 1_000
  ) {
    throw new SubscriptionProtocolError(
      "SubscriptionCursorExpired",
      "Subscription cursor has expired or is invalid.",
      { refreshRequired: true },
      409,
    );
  }
  return payload.sequence;
}

export async function pruneDurableSubscriptionState(): Promise<{
  eventsDeleted: number;
  subscriptionsClosed: number;
}> {
  const expiredSubscriptions = await query(
    `UPDATE object_set_subscription
        SET status = 'closed', updated_at = now()
      WHERE status = 'active' AND expires_at IS NOT NULL
        AND expires_at <= now()`,
  );
  const events = await query(
    `DELETE FROM object_set_event
      WHERE occurred_at <
        now() - make_interval(secs => $1::double precision)`,
    [EVENT_RETENTION_SECONDS],
  );
  const retained = await query(
    `SELECT count(*)::bigint AS count FROM object_set_event`,
  );
  const result = {
    eventsDeleted: events.rowCount ?? 0,
    subscriptionsClosed: expiredSubscriptions.rowCount ?? 0,
  };
  setGauge(
    "tellus_object_set_event_retained",
    Number(retained.rows[0]?.count ?? 0),
    {
    outcome: "pruned",
    },
  );
  return result;
}

function dependenciesFromCompiled(
  compiled: Awaited<ReturnType<typeof compileObjectSet>>,
): { types: string[]; properties: string[] } {
  const types = new Set<string>();
  const properties = new Set<string>();
  const walkWhere = (where: unknown) => {
    if (!where || typeof where !== "object") return;
    const value = where as Record<string, unknown>;
    if (typeof value.field === "string") properties.add(value.field);
    if (Array.isArray(value.value)) value.value.forEach(walkWhere);
  };
  for (const plan of compiled.plans) {
    types.add(plan.objectType);
    if (plan.searchAround) types.add(plan.searchAround.fromObjectType);
    walkWhere(plan.where);
    for (const name of Object.keys(plan.derivedProperties ?? {})) {
      properties.add(name);
    }
  }
  return { types: [...types].sort(), properties: [...properties].sort() };
}

export async function createDurableSubscription(input: {
  tenantId: string;
  ontologyId: string;
  ownerUserId: string;
  branchId: string | null;
  transactionId?: string | null;
  scenarioRid?: string | null;
  objectSet: ObjectSet;
  propertySet?: string[];
  referenceSet?: string[];
  requestId?: string | null;
}): Promise<DurableSubscription> {
  const counts = await query(
    `SELECT count(*) FILTER (WHERE owner_user_id = $2) AS user_count,
            count(*) AS tenant_count
       FROM object_set_subscription
      WHERE tenant_id = $1 AND status = 'active'`,
    [input.tenantId, input.ownerUserId],
  );
  const userCount = Number(counts.rows[0]?.user_count ?? 0);
  const tenantCount = Number(counts.rows[0]?.tenant_count ?? 0);
  if (userCount >= MAX_PER_USER || tenantCount >= MAX_PER_TENANT) {
    throw new SubscriptionProtocolError(
      "SubscriptionLimitExceeded",
      "The ObjectSet subscription limit was reached.",
      { userLimit: MAX_PER_USER, tenantLimit: MAX_PER_TENANT },
      429,
    );
  }
  const compiled = await compileObjectSet(
    input.objectSet,
    makeProductionCompilerDeps({
      tenant: input.tenantId,
      ontologyRid: input.ontologyId,
      branchRid: input.branchId,
      userId: input.ownerUserId,
    }),
  );
  const dependencies = dependenciesFromCompiled(compiled);
  const cursorResult = await query(
    `SELECT COALESCE(max(event_sequence), 0) AS cursor
       FROM object_set_event
      WHERE tenant_id = $1 AND ontology_id = $2`,
    [input.tenantId, input.ontologyId],
  );
  const cursor = Number(cursorResult.rows[0]?.cursor ?? 0);
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO object_set_subscription
       (subscription_id, tenant_id, ontology_id, owner_user_id, branch_id,
        transaction_id, scenario_rid, object_set, fingerprint, property_set,
        reference_set, dependency_types, dependency_properties,
        last_acknowledged_sequence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::text[],$11::text[],
             $12::text[],$13::text[],$14)`,
    [
      id,
      input.tenantId,
      input.ontologyId,
      input.ownerUserId,
      input.branchId,
      input.transactionId ?? null,
      input.scenarioRid ?? null,
      JSON.stringify(input.objectSet),
      objectSetFingerprint(input.objectSet),
      input.propertySet ?? [],
      input.referenceSet ?? [],
      dependencies.types,
      dependencies.properties,
      cursor,
    ],
  );
  recordOssV2AuditBestEffort({
    eventType: "subscription_create",
    tenantId: input.tenantId,
    ontologyId: input.ontologyId,
    userId: input.ownerUserId,
    branchId: input.branchId,
    transactionId: input.transactionId,
    scenarioRid: input.scenarioRid,
    requestId: input.requestId,
    outcome: "success",
    parameters: {
      subscriptionId: id,
      dependencyTypeCount: dependencies.types.length,
    },
  });
  return {
    id,
    tenantId: input.tenantId,
    ontologyId: input.ontologyId,
    ownerUserId: input.ownerUserId,
    branchId: input.branchId,
    transactionId: input.transactionId ?? null,
    scenarioRid: input.scenarioRid ?? null,
    objectSet: input.objectSet,
    fingerprint: objectSetFingerprint(input.objectSet),
    propertySet: input.propertySet ?? [],
    referenceSet: input.referenceSet ?? [],
    dependencyTypes: dependencies.types,
    dependencyProperties: dependencies.properties,
    lastAcknowledgedSequence: cursor,
  };
}

export async function getOwnedSubscription(input: {
  subscriptionId: string;
  tenantId: string;
  userId: string;
}): Promise<DurableSubscription> {
  const result = await query(
    `SELECT * FROM object_set_subscription
      WHERE subscription_id = $1 AND tenant_id = $2
        AND owner_user_id = $3 AND status = 'active'
        AND (expires_at IS NULL OR expires_at > now())`,
    [input.subscriptionId, input.tenantId, input.userId],
  );
  if (result.rows.length === 0) {
    throw new SubscriptionProtocolError(
      "SubscriptionNotFound",
      "ObjectSet subscription was not found.",
      {},
      404,
    );
  }
  const row = result.rows[0];
  return {
    id: row.subscription_id,
    tenantId: row.tenant_id,
    ontologyId: row.ontology_id,
    ownerUserId: row.owner_user_id,
    branchId: row.branch_id,
    transactionId: row.transaction_id,
    scenarioRid: row.scenario_rid,
    objectSet: row.object_set,
    fingerprint: row.fingerprint,
    propertySet: row.property_set ?? [],
    referenceSet: row.reference_set ?? [],
    dependencyTypes: row.dependency_types ?? [],
    dependencyProperties: row.dependency_properties ?? [],
    lastAcknowledgedSequence: Number(row.last_acknowledged_sequence),
  };
}

export async function closeOwnedSubscription(input: {
  subscriptionId: string;
  tenantId: string;
  userId: string;
}): Promise<void> {
  const result = await query(
    `UPDATE object_set_subscription
        SET status = 'closed', updated_at = now()
      WHERE subscription_id = $1 AND tenant_id = $2 AND owner_user_id = $3
      RETURNING subscription_id`,
    [input.subscriptionId, input.tenantId, input.userId],
  );
  if (result.rows.length === 0) {
    throw new SubscriptionProtocolError(
      "SubscriptionNotFound",
      "ObjectSet subscription was not found.",
      {},
      404,
    );
  }
}

export async function acknowledgeCursor(input: {
  subscriptionId: string;
  tenantId: string;
  userId: string;
  cursor: number;
}): Promise<void> {
  const result = await query(
    `UPDATE object_set_subscription
        SET last_acknowledged_sequence =
              GREATEST(last_acknowledged_sequence, $4),
            updated_at = now()
      WHERE subscription_id = $1 AND tenant_id = $2 AND owner_user_id = $3
      RETURNING subscription_id`,
    [input.subscriptionId, input.tenantId, input.userId, input.cursor],
  );
  if (result.rows.length === 0) {
    throw new SubscriptionProtocolError(
      "SubscriptionNotFound",
      "ObjectSet subscription was not found.",
      {},
      404,
    );
  }
}

export async function replayEvents(
  subscription: DurableSubscription,
  afterSequence: number,
): Promise<
  | { expired: true; cursor: number }
  | { expired: false; events: DurableEvent[]; cursor: number }
> {
  const retention = await query(
    `SELECT min(event_sequence) AS oldest, COALESCE(max(event_sequence), 0) AS newest
       FROM object_set_event
      WHERE tenant_id = $1 AND ontology_id = $2`,
    [subscription.tenantId, subscription.ontologyId],
  );
  const oldest = Number(retention.rows[0]?.oldest ?? 0);
  const newest = Number(retention.rows[0]?.newest ?? 0);
  if (oldest > 0 && afterSequence < oldest - 1) {
    return { expired: true, cursor: newest };
  }
  const result = await query(
    `SELECT event_sequence, event_id, object_type_api_name, primary_key,
            object_rid, state, object_value, changed_properties,
            changed_link_types
       FROM object_set_event
      WHERE tenant_id = $1 AND ontology_id = $2
        AND event_sequence > $3
        AND object_type_api_name = ANY($4::text[])
        AND ($5::text IS NULL OR branch_id IS NOT DISTINCT FROM $5::text)
        AND ($6::text IS NULL OR transaction_id IS NOT DISTINCT FROM $6::text)
        AND ($7::text IS NULL OR scenario_rid IS NOT DISTINCT FROM $7::text)
      ORDER BY event_sequence
      LIMIT $8`,
    [
      subscription.tenantId,
      subscription.ontologyId,
      afterSequence,
      subscription.dependencyTypes,
      subscription.branchId,
      subscription.transactionId,
      subscription.scenarioRid,
      REPLAY_BATCH,
    ],
  );
  const events = result.rows.map((row) => ({
    sequence: Number(row.event_sequence),
    eventId: row.event_id,
    objectType: row.object_type_api_name,
    primaryKey: row.primary_key,
    objectRid: row.object_rid,
    state: row.state,
    objectValue: row.object_value,
    changedProperties: row.changed_properties ?? [],
    changedLinkTypes: row.changed_link_types ?? [],
  })) as DurableEvent[];
  return {
    expired: false,
    events,
    cursor: events.length > 0
      ? events[events.length - 1]!.sequence
      : afterSequence,
  };
}

export async function loadAuthorizedEventObject(input: {
  subscription: DurableSubscription;
  event: DurableEvent;
  security: SecurityContext;
}): Promise<Record<string, unknown> | null> {
  if (input.event.state === "REMOVED") {
    return {
      __apiName: input.event.objectType,
      __primaryKey: input.event.primaryKey,
      ...(input.event.objectRid ? { __rid: input.event.objectRid } : {}),
    };
  }
  const contexts = await resolveReadContexts(
    {
      transactionId: input.subscription.transactionId,
      scenarioRid: input.subscription.scenarioRid,
    },
    {
      tenant: input.subscription.tenantId,
      ontologyId: input.subscription.ontologyId,
      branchId: input.subscription.branchId,
      userId: input.security.userId,
      markings: input.security.markings,
      cbac: input.security.cbac,
      organizations: input.security.organizations,
      markingBypass: input.security.markingBypass,
    },
  );
  const definition: ObjectSet = input.event.objectRid
    ? { type: "static", objects: [input.event.objectRid] }
    : {
        type: "filter",
        objectSet: { type: "base", objectType: input.event.objectType },
        where: {
          type: "eq",
          field: "__pk",
          value: input.event.primaryKey,
        },
      };
  const compiled = await compileObjectSet(
    definition,
    makeProductionCompilerDeps({
      tenant: input.subscription.tenantId,
      ontologyRid: input.subscription.ontologyId,
      branchRid: input.subscription.branchId,
      userId: input.subscription.ownerUserId,
    }),
  );
  const result = await loadObjectSet(
    compiled,
    {
      objectSet: definition,
      select: input.subscription.propertySet,
      selectV2: [],
      pageSize: 1,
    },
    {
      ontologyRid: input.subscription.ontologyId,
      branchRid: input.subscription.branchId,
      tenant: input.subscription.tenantId,
      transactionId: input.subscription.transactionId,
      transactionVersion: contexts.transaction?.version ?? null,
      scenarioRid: input.subscription.scenarioRid,
      scenarioVersion: contexts.scenario?.version ?? null,
      snapshot: false,
    },
    makeProductionExecutorDeps(
      {
        securityFilter: buildSecurityFilter(input.security),
        branchId: input.subscription.branchId,
        ontologyId: input.subscription.ontologyId,
        userId: input.security.userId,
        tenant: input.subscription.tenantId,
        markings: input.security.markings,
        cbac: input.security.cbac,
        organizations: input.security.organizations,
        markingBypass: input.security.markingBypass,
      },
      { snapshot: false, readContexts: contexts },
    ),
  );
  return result.data[0] ?? null;
}

async function persistEvent(payload: {
  tenantId?: string;
  ontologyId?: string;
  objectType?: string;
  objectTypeApiName?: string;
  primaryKeys?: Array<string | number>;
  executionId?: string;
  branchId?: string | null;
  transactionId?: string | null;
  scenarioRid?: string | null;
  changedProperties?: string[];
  changedLinkTypes?: string[];
}): Promise<void> {
  const ontologyId = payload.ontologyId;
  const objectType = payload.objectType ?? payload.objectTypeApiName;
  if (!ontologyId || !objectType) return;
  for (const primaryKeyValue of payload.primaryKeys ?? []) {
    const primaryKey = String(primaryKeyValue);
    const objectResult = await query(
      `SELECT rid, properties
         FROM object_instances
        WHERE ontology_id = $1 AND object_type_api_name = $2
          AND primary_key = $3
          AND ($4::text IS NULL OR branch_id::text = $4::text)
        ORDER BY last_modified_at DESC
        LIMIT 1`,
      [ontologyId, objectType, primaryKey, payload.branchId ?? null],
    );
    const object = objectResult.rows[0];
    const state = object ? "ADDED_OR_UPDATED" : "REMOVED";
    const dedupe = `${payload.executionId ?? "event"}:${objectType}:${primaryKey}:${state}`;
    await query(
      `INSERT INTO object_set_event
         (deduplication_key, tenant_id, ontology_id, branch_id,
          transaction_id, scenario_rid, object_type_api_name, primary_key,
          object_rid, state, object_value, changed_properties,
          changed_link_types)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::text[],$13::text[])
       ON CONFLICT (deduplication_key) DO NOTHING`,
      [
        dedupe,
        payload.tenantId ?? "default",
        ontologyId,
        payload.branchId ?? null,
        payload.transactionId ?? null,
        payload.scenarioRid ?? null,
        objectType,
        primaryKey,
        object?.rid ?? null,
        state,
        object ? JSON.stringify(object.properties ?? {}) : null,
        payload.changedProperties ?? [],
        payload.changedLinkTypes ?? [],
      ],
    );
  }
}

export function ensureDurableSubscriptionEventBridge(): void {
  if (bridgeAttached) return;
  bridgeAttached = true;
  void pruneDurableSubscriptionState().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "object_set_event.prune_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  retentionTimer = setInterval(() => {
    void pruneDurableSubscriptionState().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "object_set_event.prune_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }, 60 * 60 * 1000);
  retentionTimer.unref();
  eventBus.on(
    "ws:event",
    (event: { event?: string; payload?: unknown }) => {
      if (event.event !== "object_set.changed") return;
      void persistEvent(
        (event.payload ?? {}) as Parameters<typeof persistEvent>[0],
      ).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "object_set_event.persist_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    },
  );
}
