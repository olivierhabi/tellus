import crypto from "node:crypto";
import { query } from "../../db";
import { deterministicObjectRid } from "../objectIdentity";
import { matchesWhere } from "./subscriptionRegistry";
import { ObjectSetExecutionError } from "./objectSetExecutor";

export type ReadContextKind = "transaction" | "scenario";

export interface ResolvedReadContext {
  id: string;
  rid: string;
  kind: ReadContextKind;
  tenantId: string;
  ontologyId: string;
  branchId: string | null;
  ownerUserId: string;
  version: number;
  status: "open" | "committed";
}

export interface ReadContextSecurity {
  tenant: string;
  ontologyId: string;
  branchId: string | null;
  userId: string;
  markings: string[];
  cbac: string[];
  organizations: string[];
  markingBypass: boolean;
}

function contextError(
  name: string,
  message: string,
  parameters: Record<string, unknown>,
  statusCode: number,
): never {
  throw new ObjectSetExecutionError(name, message, parameters, statusCode);
}

export async function resolveReadContext(
  identifier: string,
  expectedKind: ReadContextKind,
  security: ReadContextSecurity,
): Promise<ResolvedReadContext> {
  const result = await query(
    `SELECT context_id, rid, kind, tenant_id, ontology_id, branch_id,
            owner_user_id, allowed_user_ids, status, version, expires_at
       FROM ontology_read_context
      WHERE rid = $1 OR context_id::text = $1
      LIMIT 1`,
    [identifier],
  );
  if (result.rows.length === 0 || result.rows[0].kind !== expectedKind) {
    contextError(
      expectedKind === "transaction"
        ? "OntologyTransactionNotFound"
        : "OntologyScenarioNotFound",
      `${expectedKind} read context was not found.`,
      { [expectedKind === "transaction" ? "transactionId" : "scenarioRid"]: identifier },
      404,
    );
  }
  const row = result.rows[0] as {
    context_id: string;
    rid: string;
    kind: ReadContextKind;
    tenant_id: string;
    ontology_id: string;
    branch_id: string | null;
    owner_user_id: string;
    allowed_user_ids: string[];
    status: string;
    version: string | number;
    expires_at: Date | string | null;
  };
  // Scope mismatches are deliberately indistinguishable from absence.
  if (
    row.tenant_id !== security.tenant ||
    row.ontology_id !== security.ontologyId
  ) {
    contextError(
      expectedKind === "transaction"
        ? "OntologyTransactionNotFound"
        : "OntologyScenarioNotFound",
      `${expectedKind} read context was not found.`,
      {},
      404,
    );
  }
  if ((row.branch_id ?? null) !== (security.branchId ?? null)) {
    contextError(
      expectedKind === "transaction"
        ? "OntologyTransactionBranchMismatch"
        : "OntologyScenarioBranchMismatch",
      `${expectedKind} belongs to a different branch.`,
      { branch: security.branchId },
      409,
    );
  }
  if (
    row.owner_user_id !== security.userId &&
    !(row.allowed_user_ids ?? []).includes(security.userId) &&
    !security.markingBypass
  ) {
    contextError(
      expectedKind === "transaction"
        ? "OntologyTransactionNotFound"
        : "OntologyScenarioNotFound",
      `${expectedKind} read context was not found.`,
      {},
      404,
    );
  }
  if (
    row.status === "expired" ||
    row.status === "deleted" ||
    (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
  ) {
    contextError(
      expectedKind === "transaction"
        ? "OntologyTransactionExpired"
        : "OntologyScenarioExpired",
      `${expectedKind} is no longer readable.`,
      { status: row.status },
      410,
    );
  }
  if (row.status !== "open" && row.status !== "committed") {
    contextError(
      expectedKind === "transaction"
        ? "OntologyTransactionInvalidState"
        : "OntologyScenarioInvalidState",
      `${expectedKind} is not readable in state ${row.status}.`,
      { status: row.status },
      409,
    );
  }
  return {
    id: row.context_id,
    rid: row.rid,
    kind: row.kind,
    tenantId: row.tenant_id,
    ontologyId: row.ontology_id,
    branchId: row.branch_id,
    ownerUserId: row.owner_user_id,
    version: Number(row.version),
    status: row.status,
  };
}

export async function resolveReadContexts(
  identifiers: {
    transactionId?: string | null;
    scenarioRid?: string | null;
  },
  security: ReadContextSecurity,
): Promise<{
  transaction: ResolvedReadContext | null;
  scenario: ResolvedReadContext | null;
}> {
  // The public 2.70 query type exposes both independent optional parameters
  // and does not declare mutual exclusion. Composition is therefore explicit:
  // base branch -> scenario -> transaction.
  const [scenario, transaction] = await Promise.all([
    identifiers.scenarioRid
      ? resolveReadContext(identifiers.scenarioRid, "scenario", security)
      : null,
    identifiers.transactionId
      ? resolveReadContext(identifiers.transactionId, "transaction", security)
      : null,
  ]);
  return { scenario, transaction };
}

export async function createReadContext(input: {
  kind: ReadContextKind;
  tenantId: string;
  ontologyId: string;
  branchId?: string | null;
  ownerUserId: string;
  allowedUserIds?: string[];
  expiresAt?: Date | null;
}): Promise<ResolvedReadContext> {
  const id = crypto.randomUUID();
  const rid =
    input.kind === "scenario"
      ? `ri.ontology.main.scenario.${id}`
      : `ri.ontology.main.transaction.${id}`;
  const result = await query(
    `INSERT INTO ontology_read_context
       (context_id, rid, kind, tenant_id, ontology_id, branch_id,
        owner_user_id, allowed_user_ids, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9)
     RETURNING context_id, rid, kind, tenant_id, ontology_id, branch_id,
               owner_user_id, version, status`,
    [
      id,
      rid,
      input.kind,
      input.tenantId,
      input.ontologyId,
      input.branchId ?? null,
      input.ownerUserId,
      input.allowedUserIds ?? [],
      input.expiresAt ?? null,
    ],
  );
  const row = result.rows[0];
  return {
    id: row.context_id,
    rid: row.rid,
    kind: row.kind,
    tenantId: row.tenant_id,
    ontologyId: row.ontology_id,
    branchId: row.branch_id,
    ownerUserId: row.owner_user_id,
    version: Number(row.version),
    status: row.status,
  };
}

export async function appendObjectContextEdit(input: {
  contextId: string;
  objectType: string;
  primaryKey: string;
  operation: "create" | "modify" | "delete";
  properties?: Record<string, unknown>;
  objectRid?: string | null;
}): Promise<number> {
  const result = await query(
    `WITH locked AS (
       UPDATE ontology_read_context
          SET version = version + 1, updated_at = now()
        WHERE context_id = $1 AND status = 'open'
        RETURNING context_id, version
     ), inserted AS (
       INSERT INTO ontology_read_context_object_edit
         (context_id, context_version, object_type_api_name, primary_key, object_rid,
          operation, properties, changed_properties, base_properties,
          base_markings, base_object_version, base_object_rid)
       SELECT locked.context_id, locked.version, $2, $3, $4, $5, $6::jsonb,
              ARRAY(SELECT jsonb_object_keys($6::jsonb))
              , base.properties, base.markings, base.version, base.rid
         FROM locked
         JOIN ontology_read_context context
           ON context.context_id = locked.context_id
         LEFT JOIN LATERAL (
           SELECT instance.properties, instance.markings, instance.version,
                  instance.rid
             FROM object_instances instance
            WHERE instance.ontology_id = context.ontology_id
              AND instance.object_type_api_name = $2
              AND instance.primary_key = $3
              AND (
                context.branch_id IS NULL
                OR instance.branch_id::text = context.branch_id
              )
            LIMIT 1
         ) base ON TRUE
       RETURNING edit_sequence, context_version, object_rid,
                 changed_properties
     ), persisted_event AS (
       INSERT INTO object_set_event
         (deduplication_key, tenant_id, ontology_id, branch_id,
          transaction_id, scenario_rid, object_type_api_name, primary_key,
          object_rid, state, object_value, changed_properties,
          changed_link_types)
       SELECT
         'context-object:' || context.context_id::text || ':' ||
           inserted.edit_sequence::text,
         context.tenant_id, context.ontology_id, context.branch_id,
         CASE WHEN context.kind = 'transaction'
              THEN context.context_id::text END,
         CASE WHEN context.kind = 'scenario' THEN context.rid END,
         $2, $3, inserted.object_rid,
         CASE WHEN $5 = 'delete' THEN 'REMOVED'
              ELSE 'ADDED_OR_UPDATED' END,
         CASE WHEN $5 = 'delete' THEN NULL ELSE $6::jsonb END,
         inserted.changed_properties, ARRAY[]::text[]
       FROM inserted
       JOIN ontology_read_context context ON context.context_id = $1
       ON CONFLICT (deduplication_key) DO NOTHING
     )
     SELECT edit_sequence FROM inserted`,
    [
      input.contextId,
      input.objectType,
      input.primaryKey,
      input.objectRid ?? null,
      input.operation,
      JSON.stringify(input.properties ?? {}),
    ],
  );
  if (result.rows.length === 0) {
    contextError(
      "OntologyReadContextNotWritable",
      "Read context is missing or no longer open.",
      { contextId: input.contextId },
      409,
    );
  }
  return Number(result.rows[0].edit_sequence);
}

export async function appendLinkContextEdit(input: {
  contextId: string;
  linkType: string;
  sourceObjectType: string;
  sourcePrimaryKey: string;
  targetObjectType: string;
  targetPrimaryKey: string;
  operation: "add" | "remove";
}): Promise<number> {
  const result = await query(
    `WITH locked AS (
       UPDATE ontology_read_context
          SET version = version + 1, updated_at = now()
        WHERE context_id = $1 AND status = 'open'
        RETURNING context_id, version
     ), inserted AS (
       INSERT INTO ontology_read_context_link_edit
         (context_id, context_version, link_type_api_name,
          source_object_type, source_primary_key,
          target_object_type, target_primary_key, operation)
       SELECT context_id, version, $2, $3, $4, $5, $6, $7
         FROM locked
       RETURNING edit_sequence
     ), persisted_event AS (
       INSERT INTO object_set_event
         (deduplication_key, tenant_id, ontology_id, branch_id,
          transaction_id, scenario_rid, object_type_api_name, primary_key,
          object_rid, state, object_value, changed_properties,
          changed_link_types)
       SELECT
         'context-link:' || context.context_id::text || ':' ||
           inserted.edit_sequence::text,
         context.tenant_id, context.ontology_id, context.branch_id,
         CASE WHEN context.kind = 'transaction'
              THEN context.context_id::text END,
         CASE WHEN context.kind = 'scenario' THEN context.rid END,
         $3, $4, NULL, 'ADDED_OR_UPDATED', NULL,
         ARRAY[]::text[], ARRAY[$2]::text[]
       FROM inserted
       JOIN ontology_read_context context ON context.context_id = $1
       ON CONFLICT (deduplication_key) DO NOTHING
     )
     SELECT edit_sequence FROM inserted`,
    [
      input.contextId,
      input.linkType,
      input.sourceObjectType,
      input.sourcePrimaryKey,
      input.targetObjectType,
      input.targetPrimaryKey,
      input.operation,
    ],
  );
  if (result.rows.length === 0) {
    contextError(
      "OntologyReadContextNotWritable",
      "Read context is missing or no longer open.",
      { contextId: input.contextId },
      409,
    );
  }
  return Number(result.rows[0].edit_sequence);
}

export async function composeReadContextLinkTargets(input: {
  linkType: string;
  direction: "forward" | "reverse";
  sourcePrimaryKey: string;
  baseTargetPrimaryKeys: string[];
  contexts: {
    scenario: ResolvedReadContext | null;
    transaction: ResolvedReadContext | null;
  };
  versions?: {
    scenarioVersion: number | null;
    transactionVersion: number | null;
  };
}): Promise<string[]> {
  const targets = new Set(input.baseTargetPrimaryKeys);
  const specs = [
    input.contexts.scenario
      ? {
          context: input.contexts.scenario,
          version:
            input.versions?.scenarioVersion ?? input.contexts.scenario.version,
        }
      : null,
    input.contexts.transaction
      ? {
          context: input.contexts.transaction,
          version:
            input.versions?.transactionVersion ??
            input.contexts.transaction.version,
        }
      : null,
  ].filter(
    (
      value,
    ): value is { context: ResolvedReadContext; version: number } =>
      value !== null,
  );
  for (const spec of specs) {
    const sourceColumn =
      input.direction === "forward"
        ? "source_primary_key"
        : "target_primary_key";
    const targetColumn =
      input.direction === "forward"
        ? "target_primary_key"
        : "source_primary_key";
    const result = await query(
      `SELECT ${targetColumn} AS target_primary_key, operation
         FROM ontology_read_context_link_edit
        WHERE context_id = $1
          AND context_version <= $2
          AND link_type_api_name = $3
          AND ${sourceColumn} = $4
        ORDER BY edit_sequence`,
      [
        spec.context.id,
        spec.version,
        input.linkType,
        input.sourcePrimaryKey,
      ],
    );
    for (const row of result.rows) {
      const target = String(row.target_primary_key);
      if (row.operation === "add") targets.add(target);
      else targets.delete(target);
    }
  }
  return [...targets].sort();
}

function visibleByDocumentSecurity(
  doc: Record<string, unknown>,
  security: ReadContextSecurity,
): boolean {
  if (security.markingBypass) return true;
  const rowMarkings = Array.isArray(doc.__markings)
    ? (doc.__markings as string[])
    : Array.isArray(doc.markings)
      ? (doc.markings as string[])
      : [];
  if (!rowMarkings.every((marking) => security.markings.includes(marking))) {
    return false;
  }
  const embedded = doc._security as
    | {
        markings?: string[];
        cbac?: string[];
        organizations?: string[];
      }
    | undefined;
  if (
    embedded?.markings &&
    !embedded.markings.every((marking) => security.markings.includes(marking))
  ) {
    return false;
  }
  if (
    embedded?.cbac?.length &&
    !embedded.cbac.some((entry) => security.cbac.includes(entry))
  ) {
    return false;
  }
  if (
    embedded?.organizations?.length &&
    !embedded.organizations.some((entry) =>
      security.organizations.includes(entry),
    )
  ) {
    return false;
  }
  return true;
}

async function applyOneContext(
  context: ResolvedReadContext,
  objectType: string,
  baseHits: Array<Record<string, unknown>>,
  where: unknown,
  security: ReadContextSecurity,
  maxVersion: number,
): Promise<Array<Record<string, unknown>>> {
  const editsResult = await query(
    `SELECT edit_sequence, primary_key, object_rid, operation, properties,
            base_properties, base_markings, base_object_version,
            base_object_rid
       FROM ontology_read_context_object_edit
      WHERE context_id = $1 AND object_type_api_name = $2
        AND context_version <= $3
      ORDER BY edit_sequence`,
    [context.id, objectType, maxVersion],
  );
  if (editsResult.rows.length === 0) return baseHits;
  const editedPks = [
    ...new Set(editsResult.rows.map((row) => String(row.primary_key))),
  ];
  const baseResult = await query(
    `SELECT primary_key, properties, markings, version, rid
       FROM object_instances
      WHERE ontology_id = $1
        AND object_type_api_name = $2
        AND primary_key = ANY($3::text[])
        AND ($4::text IS NULL OR branch_id::text = $4::text)`,
    [security.ontologyId, objectType, editedPks, security.branchId],
  );
  const byPk = new Map<string, Record<string, unknown>>();
  for (const hit of baseHits) {
    byPk.set(String(hit.__primaryKey ?? hit.__pk), { ...hit });
  }
  for (const row of editsResult.rows) {
    if (!row.base_properties || byPk.has(String(row.primary_key))) continue;
    const pk = String(row.primary_key);
    byPk.set(pk, {
      ...(row.base_properties as Record<string, unknown>),
      __pk: pk,
      __primaryKey: pk,
      __apiName: objectType,
      __version:
        row.base_object_version == null
          ? undefined
          : Number(row.base_object_version),
      __rid:
        row.base_object_rid ??
        deterministicObjectRid(security.ontologyId, objectType, pk),
      __markings: row.base_markings ?? [],
    });
  }
  for (const row of baseResult.rows) {
    const pk = String(row.primary_key);
    if (byPk.has(pk)) continue;
    byPk.set(pk, {
      ...(row.properties as Record<string, unknown>),
      __pk: pk,
      __primaryKey: pk,
      __apiName: objectType,
      __version: Number(row.version),
      __rid:
        row.rid ??
        deterministicObjectRid(security.ontologyId, objectType, pk),
      __markings: row.markings ?? [],
    });
  }
  for (const row of editsResult.rows) {
    const pk = String(row.primary_key);
    if (row.operation === "delete") {
      byPk.delete(pk);
      continue;
    }
    const existing = byPk.get(pk) ?? {
      __pk: pk,
      __primaryKey: pk,
      __apiName: objectType,
      __rid:
        row.object_rid ??
        deterministicObjectRid(security.ontologyId, objectType, pk),
    };
    byPk.set(pk, {
      ...existing,
      ...(row.properties as Record<string, unknown>),
      __rid: existing.__rid ?? row.object_rid,
      __contextVersion: context.version,
    });
  }
  return [...byPk.values()].filter(
    (doc) =>
      visibleByDocumentSecurity(doc, security) &&
      matchesWhere(doc, where),
  );
}

export async function composeReadContexts(input: {
  objectType: string;
  hits: Array<Record<string, unknown>>;
  where: unknown;
  contexts: {
    scenario: ResolvedReadContext | null;
    transaction: ResolvedReadContext | null;
  };
  security: ReadContextSecurity;
  versions?: {
    scenarioVersion: number | null;
    transactionVersion: number | null;
  };
}): Promise<Array<Record<string, unknown>>> {
  let composed = input.hits;
  if (input.contexts.scenario) {
    composed = await applyOneContext(
      input.contexts.scenario,
      input.objectType,
      composed,
      input.where,
      input.security,
      input.versions?.scenarioVersion ?? input.contexts.scenario.version,
    );
  }
  if (input.contexts.transaction) {
    composed = await applyOneContext(
      input.contexts.transaction,
      input.objectType,
      composed,
      input.where,
      input.security,
      input.versions?.transactionVersion ?? input.contexts.transaction.version,
    );
  }
  return composed;
}

/**
 * Adjust an OpenSearch total for objects whose membership is changed by the
 * scenario/transaction overlay. Only affected primary keys are materialized,
 * so this remains proportional to the transaction rather than the base set.
 */
export async function adjustReadContextTotal(input: {
  objectType: string;
  baseTotal: number;
  where: unknown;
  contexts: {
    scenario: ResolvedReadContext | null;
    transaction: ResolvedReadContext | null;
  };
  security: ReadContextSecurity;
  versions?: {
    scenarioVersion: number | null;
    transactionVersion: number | null;
  };
}): Promise<number> {
  const specs = [
    input.contexts.scenario
      ? {
          context: input.contexts.scenario,
          version:
            input.versions?.scenarioVersion ?? input.contexts.scenario.version,
        }
      : null,
    input.contexts.transaction
      ? {
          context: input.contexts.transaction,
          version:
            input.versions?.transactionVersion ??
            input.contexts.transaction.version,
        }
      : null,
  ].filter(
    (
      value,
    ): value is { context: ResolvedReadContext; version: number } =>
      value !== null,
  );
  if (specs.length === 0) return input.baseTotal;
  const affected = new Set<string>();
  for (const spec of specs) {
    const result = await query(
      `SELECT DISTINCT primary_key
         FROM ontology_read_context_object_edit
        WHERE context_id = $1
          AND object_type_api_name = $2
          AND context_version <= $3`,
      [spec.context.id, input.objectType, spec.version],
    );
    for (const row of result.rows) affected.add(String(row.primary_key));
  }
  if (affected.size === 0) return input.baseTotal;
  const baseResult = await query(
    `SELECT primary_key, properties, markings, version, rid
       FROM object_instances
      WHERE ontology_id = $1
        AND object_type_api_name = $2
        AND primary_key = ANY($3::text[])
        AND ($4::text IS NULL OR branch_id::text = $4::text)`,
    [
      input.security.ontologyId,
      input.objectType,
      [...affected],
      input.security.branchId,
    ],
  );
  const baseHits = baseResult.rows.map((row) => ({
    ...(row.properties as Record<string, unknown>),
    __pk: String(row.primary_key),
    __primaryKey: String(row.primary_key),
    __apiName: input.objectType,
    __version: Number(row.version),
    __rid:
      row.rid ??
      deterministicObjectRid(
        input.security.ontologyId,
        input.objectType,
        String(row.primary_key),
      ),
    __markings: row.markings ?? [],
  }));
  const before = baseHits.filter(
    (doc) =>
      visibleByDocumentSecurity(doc, input.security) &&
      matchesWhere(doc, input.where),
  ).length;
  const after = (
    await composeReadContexts({
      objectType: input.objectType,
      hits: baseHits,
      where: input.where,
      contexts: input.contexts,
      security: input.security,
      versions: input.versions,
    })
  ).length;
  return Math.max(0, input.baseTotal + after - before);
}
