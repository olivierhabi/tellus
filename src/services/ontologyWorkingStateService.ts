import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { getClient, query } from "../db";
import { isDatasetFormat } from "../domain/datasetFormats";
import { appError } from "../utils/appError";
import { deriveMainBranchId } from "./branchContext";
import { assertCanonicalFoundryPath } from "./datasourcePathValidation";
import { sendSignal } from "./funnel/durableWorkflow";

export type OntologyResourceKind =
  | "objectType" | "property" | "linkType" | "actionType" | "interface"
  | "sharedProperty" | "group" | "groupMembership" | "datasource" | "binding";
export type OntologyChangeOperation =
  | "create" | "modify" | "delete" | "bind" | "index" | "migrate" | "restore" | "other";
export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  key: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  resourceKind: OntologyResourceKind;
  resourceId: string;
  resourceUrl?: string | null;
  acknowledgementRequired?: boolean;
}

export interface WorkingChangeInput {
  changeId: string;
  resourceKind: OntologyResourceKind;
  resourceId: string;
  operation: OntologyChangeOperation;
  proposedValue?: unknown;
  patch?: Record<string, unknown>;
  summary: string;
  dependencies?: string[];
  destructive?: { acknowledgementRequired?: boolean; resourceName?: string; message?: string } | null;
  resourceUrl?: string | null;
  acknowledged?: boolean;
}

export interface WorkingChange extends WorkingChangeInput {
  baseSnapshot: unknown;
  baseRevision: string | null;
  issues: ValidationIssue[];
  acknowledged: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkingStateReview {
  workingStateId: string | null;
  ontologyId: string;
  branchId: string;
  branchName: string;
  baseRevision: number;
  currentRevision: number;
  stale: boolean;
  changes: WorkingChange[];
  resourceCount: number;
  editCount: number;
  errorCount: number;
  warningCount: number;
  protectedResources: Array<{ resourceKind: OntologyResourceKind; resourceId: string; policyRid: string | null }>;
}

export interface WorkingStateConflict {
  key: string;
  changeId: string;
  resourceKind: OntologyResourceKind;
  resourceId: string;
  field: string;
  baseValue: unknown;
  latestValue: unknown;
  workingValue: unknown;
}

export type ConflictResolution = {
  choice: "latest" | "working" | "manual";
  value?: unknown;
};

const RESOURCE_KINDS = new Set<OntologyResourceKind>([
  "objectType", "property", "linkType", "actionType", "interface",
  "sharedProperty", "group", "groupMembership", "datasource", "binding",
]);
const OPERATIONS = new Set<OntologyChangeOperation>([
  "create", "modify", "delete", "bind", "index", "migrate", "restore", "other",
]);
const OBJECT_API_NAME = /^[A-Z][A-Za-z0-9]{0,99}$/;
const LOWER_API_NAME = /^[a-z][A-Za-z0-9]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CanonicalFoundryDatasource = {
  id: string;
  name: string;
  filePath: string;
  fileFormat: string;
};

export async function resolveCanonicalFoundryDatasource(
  client: Pick<PoolClient, "query">,
  value: Record<string, unknown>,
): Promise<CanonicalFoundryDatasource | null> {
  if (value.foundryDatasetId == null) return null;
  const datasetId = String(value.foundryDatasetId).trim();
  if (!UUID.test(datasetId)) {
    throw appError("DATASOURCE_PATH_INVALID", `foundryDatasetId '${datasetId}' must be a valid UUID.`);
  }
  const result = await client.query(
    `SELECT id::text AS id, name, file_path, format
       FROM foundry_datasets
      WHERE id=$1::uuid
      LIMIT 1`,
    [datasetId],
  );
  if (!result.rowCount) {
    throw appError("DATASOURCE_NOT_FOUND", `Foundry dataset '${datasetId}' was not found.`);
  }
  const row = result.rows[0] as { id: string; name: string; file_path: unknown; format: unknown };
  assertCanonicalFoundryPath(row.file_path);
  const canonicalPath = String(row.file_path).trim();
  const clientPath = typeof value.filePath === "string" ? value.filePath.trim() : "";
  if (clientPath && clientPath !== canonicalPath) {
    console.warn(JSON.stringify({
      event: "ontology.datasource_path_mismatch",
      foundryDatasetId: datasetId,
      clientFilePath: clientPath,
      canonicalFilePath: canonicalPath,
    }));
    throw appError(
      "DATASOURCE_PATH_MISMATCH",
      `Datasource filePath '${clientPath}' does not match canonical path '${canonicalPath}' for Foundry dataset '${datasetId}'.`,
      { foundryDatasetId: datasetId, clientFilePath: clientPath, canonicalFilePath: canonicalPath },
    );
  }
  const fileFormat = typeof row.format === "string" ? row.format.trim().toLowerCase() : "";
  if (!isDatasetFormat(fileFormat)) {
    throw appError(
      "DATASOURCE_PATH_INVALID",
      `Foundry dataset '${datasetId}' has unsupported canonical format '${fileFormat || "<empty>"}'.`,
    );
  }
  return { id: row.id, name: row.name, filePath: canonicalPath, fileFormat };
}

export function validateDraftObjectTypeId(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" && UUID.test(value)
    ? null
    : "objectTypeId must be a valid UUID when supplied.";
}

export function objectTypeCreateConflict(
  error: unknown,
  value: Record<string, unknown>,
): { code: "OBJECT_TYPE_ALREADY_EXISTS"; message: string } | null {
  const pg = error as { code?: string; constraint?: string };
  if (pg.code !== "23505") return null;
  if (pg.constraint === "object_type_pkey") {
    return {
      code: "OBJECT_TYPE_ALREADY_EXISTS",
      message: `Object type ID '${String(value.objectTypeId ?? "")}' is already in use.`,
    };
  }
  if (pg.constraint === "object_type_ontology_id_api_name_key") {
    return {
      code: "OBJECT_TYPE_ALREADY_EXISTS",
      message: `Object type API name '${String(value.apiName ?? "")}' is already in use.`,
    };
  }
  return null;
}

export function stableOntologyValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableOntologyValue).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${stableOntologyValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

const stable = stableOntologyValue;

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function parseJson<T>(value: T | string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function camelSnapshot(kind: OntologyResourceKind, row: Record<string, unknown> | null): unknown {
  if (!row) return null;
  if (kind === "objectType") return {
    objectTypeId: row.object_type_id, apiName: row.api_name, displayName: row.display_name,
    pluralName: row.plural_name ?? null, description: row.description ?? null,
    aliases: row.aliases ?? [], icon: row.icon, iconColor: row.icon_color,
    status: row.status, visibility: row.visibility, editsViaActionsOnly: row.edits_via_actions_only,
    primaryKeyPropertyId: row.primary_key_property_id, titlePropertyId: row.title_property_id,
    version: Number(row.version ?? 1),
  };
  if (kind === "property") return {
    propertyId: row.property_id, apiName: row.api_name, displayName: row.display_name,
    description: row.description ?? null, baseType: row.base_type, isRequired: row.is_required,
    ordinal: row.ordinal, visibility: row.visibility,
    conditionalFormatting: row.conditional_formatting ?? null,
  };
  if (kind === "actionType") return {
    actionTypeId: row.action_type_id, apiName: row.api_name, displayName: row.display_name,
    description: row.description, icon: row.icon_name, iconColor: row.icon_color,
    parameters: row.parameters, rules: row.rules, submissionCriteria: row.submission_criteria,
    sideEffects: row.side_effects, isEnabled: row.is_enabled,
  };
  if (kind === "linkType") return {
    linkTypeId: row.link_type_id, apiName: row.api_name, displayName: row.display_name,
    description: row.description, cardinality: row.cardinality,
    sourceObjectTypeId: row.source_object_type, targetObjectTypeId: row.target_object_type,
    sourcePropertyId: row.source_property_id, targetPropertyId: row.target_property_id,
    resolverConfig: row.resolver_config ?? null, status: row.status, visibility: row.visibility,
  };
  return row;
}

async function resolveBranch(client: PoolClient, ontologyId: string, branchRef?: string | null) {
  const ref = branchRef?.trim() || "main";
  const result = await client.query(
    `SELECT branch_id, name, status FROM ontology_branch
      WHERE ontology_id = $1 AND (branch_id::text = $2 OR lower(name) = lower($2)) LIMIT 1`,
    [ontologyId, ref],
  );
  if (result.rowCount) return result.rows[0] as { branch_id: string; name: string; status: string };
  if (ref !== "main") throw appError("BRANCH_NOT_FOUND", `Branch '${ref}' was not found.`);
  const branchId = deriveMainBranchId(ontologyId);
  const inserted = await client.query(
    `INSERT INTO ontology_branch (branch_id, ontology_id, name, status, created_by)
     VALUES ($1, $2, 'main', 'OPEN', 'system')
     ON CONFLICT (ontology_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING branch_id, name, status`, [branchId, ontologyId],
  );
  return inserted.rows[0] as { branch_id: string; name: string; status: string };
}

async function revision(client: PoolClient, ontologyId: string, branchId: string): Promise<number> {
  const result = await client.query(
    `INSERT INTO ontology_schema_revision (ontology_id, branch_id, revision)
     VALUES ($1, $2, 0) ON CONFLICT (ontology_id, branch_id) DO UPDATE SET ontology_id = EXCLUDED.ontology_id
     RETURNING revision`, [ontologyId, branchId],
  );
  return Number(result.rows[0].revision);
}

async function snapshot(client: PoolClient, ontologyId: string, kind: OntologyResourceKind, resourceId: string) {
  let result;
  if (kind === "objectType") {
    result = await client.query(`SELECT * FROM object_type WHERE ontology_id=$1 AND (api_name=$2 OR object_type_id::text=$2)`, [ontologyId, resourceId]);
  } else if (kind === "property") {
    const split = resourceId.lastIndexOf(".");
    const objectId = split > 0 ? resourceId.slice(0, split) : "";
    const propertyId = split > 0 ? resourceId.slice(split + 1) : resourceId;
    result = await client.query(
      `SELECT p.* FROM property p JOIN object_type ot ON ot.object_type_id=p.object_type_id
       WHERE ot.ontology_id=$1 AND (ot.api_name=$2 OR ot.object_type_id::text=$2)
         AND (p.api_name=$3 OR p.property_id::text=$3)`, [ontologyId, objectId, propertyId],
    );
  } else if (kind === "actionType") {
    result = await client.query(`SELECT * FROM action_type WHERE ontology_id=$1 AND (api_name=$2 OR action_type_id::text=$2)`, [ontologyId, resourceId]);
  } else if (kind === "linkType") {
    result = await client.query(`SELECT * FROM link_type WHERE ontology_id=$1 AND (api_name=$2 OR link_type_id::text=$2)`, [ontologyId, resourceId]);
  } else if (kind === "group") {
    result = await client.query(`SELECT * FROM object_type_group WHERE ontology_id=$1 AND (api_name=$2 OR group_id::text=$2)`, [ontologyId, resourceId]);
  } else if (kind === "datasource") {
    result = await client.query(
      `SELECT bd.* FROM backing_datasource bd JOIN object_type ot ON ot.object_type_id=bd.object_type_id
       WHERE ot.ontology_id=$1 AND (ot.api_name=$2 OR ot.object_type_id::text=$2)`, [ontologyId, resourceId],
    );
  } else if (kind === "groupMembership") {
    const [groupId, objectTypeId] = resourceId.split(":");
    result = await client.query(
      `SELECT m.group_id, m.object_type_id FROM object_type_group_member m
       WHERE m.group_id::text=$1 AND m.object_type_id::text=$2`, [groupId, objectTypeId],
    );
  } else {
    return null;
  }
  return camelSnapshot(kind, (result.rows[0] as Record<string, unknown> | undefined) ?? null);
}

function overlaySnapshot(base: unknown, change: WorkingChange): unknown {
  if (change.operation === "delete") return null;
  const proposed = change.proposedValue && typeof change.proposedValue === "object"
    ? change.proposedValue as Record<string, unknown> : {};
  const current = base && typeof base === "object" ? base as Record<string, unknown> : {};
  return { ...current, ...proposed, ...(change.patch ?? {}) };
}

async function savedChangesWithClient(client: PoolClient, ontologyId: string, branchId: string): Promise<WorkingChange[]> {
  const rows = await client.query(`SELECT changes FROM ontology_saved_change_set
    WHERE ontology_id=$1 AND branch_id=$2 ORDER BY saved_revision,created_at`, [ontologyId, branchId]);
  return rows.rows.flatMap((row) => parseJson<WorkingChange[]>(row.changes, []));
}

async function branchSnapshot(client: PoolClient, ontologyId: string,
  branch: { branch_id: string; name: string }, kind: OntologyResourceKind, resourceId: string) {
  let value = await snapshot(client, ontologyId, kind, resourceId);
  if (branch.name.toLowerCase() === "main") return value;
  for (const change of await savedChangesWithClient(client, ontologyId, branch.branch_id)) {
    if (change.resourceKind === kind && change.resourceId === resourceId) value = overlaySnapshot(value, change);
  }
  return value;
}

export async function getSavedBranchChanges(ontologyId: string, principalId: string, branchRef?: string | null) {
  void principalId;
  const client = await getClient();
  try {
    const branch = await resolveBranch(client, ontologyId, branchRef);
    return branch.name.toLowerCase() === "main" ? [] : savedChangesWithClient(client, ontologyId, branch.branch_id);
  } finally { client.release(); }
}

function issue(input: WorkingChangeInput, key: string, severity: IssueSeverity, code: string, message: string, ack = false): ValidationIssue {
  return { key: `${input.changeId}:${key}`, severity, code, message, resourceKind: input.resourceKind,
    resourceId: input.resourceId, resourceUrl: input.resourceUrl, acknowledgementRequired: ack };
}

function validateShape(input: WorkingChangeInput, effective: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const apiName = typeof effective.apiName === "string" ? effective.apiName.trim() : "";
  if ((input.resourceKind === "objectType" && (input.operation === "create" || "apiName" in effective)) && !OBJECT_API_NAME.test(apiName)) {
    issues.push(issue(input, "api-name", "error", "INVALID_API_NAME", "Object type API names must be 1–100 alphanumeric characters and begin with an uppercase letter."));
  }
  if (["property", "linkType", "actionType"].includes(input.resourceKind) &&
      (input.operation === "create" || "apiName" in effective) && !LOWER_API_NAME.test(apiName)) {
    issues.push(issue(input, "api-name", "error", "INVALID_API_NAME", "API names must be 1–100 alphanumeric characters and begin with a lowercase letter."));
  }
  if (input.operation === "create" && typeof effective.displayName !== "string") {
    issues.push(issue(input, "display-name", "error", "REQUIRED_FIELD_MISSING", "Display name is required."));
  }
  if (input.resourceKind === "objectType" && input.operation === "create") {
    const objectTypeIdError = validateDraftObjectTypeId(effective.objectTypeId);
    if (objectTypeIdError)
      issues.push(issue(input, "object-type-id", "error", "INVALID_OBJECT_TYPE_ID", objectTypeIdError));
    if (typeof effective.pluralName !== "string" || !effective.pluralName.trim())
      issues.push(issue(input, "plural-name", "error", "REQUIRED_FIELD_MISSING", "Plural display name is required."));
    const properties = Array.isArray(effective.properties) ? effective.properties as Array<Record<string, unknown>> : [];
    if (!properties.length) issues.push(issue(input, "properties", "error", "REQUIRED_FIELD_MISSING", "At least one property is required."));
    if (!effective.primaryKeyProperty) issues.push(issue(input, "primary-key", "error", "REQUIRED_FIELD_MISSING", "A primary key is required."));
    if (!effective.titleProperty) issues.push(issue(input, "title-key", "error", "REQUIRED_FIELD_MISSING", "A title key is required."));
    if (!effective.datasource && !effective.allowUnbacked)
      issues.push(issue(input, "datasource", "error", "REQUIRED_FIELD_MISSING", "A backing datasource or explicit unbacked location is required."));
  }
  if (input.resourceKind === "linkType" && input.operation === "create") {
    for (const field of ["cardinality", "sourceObjectTypeId", "targetObjectTypeId"])
      if (!effective[field]) issues.push(issue(input, field, "error", "REQUIRED_FIELD_MISSING", `${field} is required.`));
  }
  if (input.operation === "delete" || input.operation === "migrate" || input.operation === "index") {
    const message = input.destructive?.message ?? (input.operation === "index"
      ? "Indexing is an Ontology modification and may require branch policy approval."
      : "This change may break applications that use this resource.");
    issues.push(issue(input, "destructive", "warning", "DESTRUCTIVE_CHANGE", message,
      Boolean(input.destructive?.acknowledgementRequired)));
  }
  return issues;
}

/** A create wizard stages the object and its datasource as dependent changes.
 * Validation is therefore evaluated against the complete change set, not each
 * row in isolation. Otherwise a valid composite create is permanently blocked
 * by the object row's earlier, single-row datasource issue. */
export function hasCompanionDatasourceBinding(change: Pick<WorkingChange, "resourceKind" | "resourceId" | "proposedValue">, changes: ReadonlyArray<WorkingChange>) {
  const createValue = change.proposedValue as Record<string, unknown> | null;
  // New drafts carry an explicit expected datasource identity. Legacy drafts
  // predate that field, so retain a narrow RID-only compatibility path until
  // they are committed or discarded.
  const expectedDatasourceId = String(createValue?.requiredDatasourceId ?? createValue?.datasourceRid ?? createValue?.foundryDatasetId ?? "");
  return changes.some((candidate) => {
    if (candidate.resourceKind !== "datasource" || candidate.operation !== "bind" || candidate.resourceId !== change.resourceId) return false;
    const value = candidate.proposedValue as Record<string, unknown> | null;
    const datasourceId = String(value?.foundryDatasetId ?? value?.datasourceRid ?? "");
    return Boolean(datasourceId) && (!expectedDatasourceId || datasourceId === expectedDatasourceId);
  });
}

export function resolveCompositeIssues(change: WorkingChange, issues: ValidationIssue[], changes: ReadonlyArray<WorkingChange>) {
  if (change.resourceKind !== "objectType" || change.operation !== "create" || !hasCompanionDatasourceBinding(change, changes)) return issues;
  return issues.filter((value) => !(value.code === "REQUIRED_FIELD_MISSING" && value.key === `${change.changeId}:datasource`));
}

async function ensureUnique(client: PoolClient, ontologyId: string, input: WorkingChangeInput, effective: Record<string, unknown>) {
  // A delete can never introduce a name conflict, and its resource id is
  // frequently the apiName of the very row being removed — checking would
  // always flag it.
  if (input.operation === "delete") return [];
  const issues: ValidationIssue[] = [];
  if (input.resourceKind === "objectType" && input.operation === "create" && typeof effective.objectTypeId === "string") {
    const foundId = await client.query(
      `SELECT api_name FROM object_type WHERE object_type_id::text=$1`,
      [effective.objectTypeId],
    );
    if (foundId.rowCount) {
      issues.push(issue(
        input,
        "object-type-id-unique",
        "error",
        "OBJECT_TYPE_ID_CONFLICT",
        `Object type ID '${effective.objectTypeId}' is already in use by '${String(foundId.rows[0].api_name)}'.`,
      ));
    }
  }
  const name = typeof effective.apiName === "string" ? effective.apiName : null;
  if (!name || !["objectType", "actionType", "linkType"].includes(input.resourceKind)) return issues;
  const table = input.resourceKind === "objectType" ? "object_type" : input.resourceKind === "actionType" ? "action_type" : "link_type";
  const idCol = input.resourceKind === "objectType" ? "object_type_id" : input.resourceKind === "actionType" ? "action_type_id" : "link_type_id";
  const found = await client.query(`SELECT ${idCol}::text AS id, api_name FROM ${table} WHERE ontology_id=$1 AND lower(api_name)=lower($2)`, [ontologyId, name]);
  const existing = found.rows[0] as { id?: string; api_name?: string } | undefined;
  if (!existing) return issues;
  // Change ids may carry either the UUID or the apiName depending on which
  // flow staged them — treat either as "self" so edits don't self-conflict.
  const isSelf = existing.id === input.resourceId || existing.api_name === input.resourceId;
  if (!isSelf)
    issues.push(issue(input, "api-name-unique", "error", "API_NAME_CONFLICT", `API name '${name}' is already in use.`));
  return issues;
}

function rowToChange(row: Record<string, unknown>): WorkingChange {
  return {
    changeId: String(row.change_id), resourceKind: row.resource_kind as OntologyResourceKind,
    resourceId: String(row.resource_id), operation: row.operation as OntologyChangeOperation,
    baseSnapshot: parseJson(row.base_snapshot as never, null), baseRevision: row.base_revision == null ? null : String(row.base_revision),
    proposedValue: parseJson(row.proposed_value as never, undefined), patch: parseJson(row.patch as never, undefined),
    summary: String(row.summary), dependencies: (row.dependencies as string[]) ?? [],
    issues: parseJson(row.issues as never, []), destructive: parseJson(row.destructive as never, null),
    resourceUrl: row.resource_url == null ? null : String(row.resource_url), acknowledged: Boolean(row.acknowledged),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

async function reviewWithClient(client: PoolClient, ontologyId: string, principalId: string, branchRef?: string | null): Promise<WorkingStateReview> {
  const branch = await resolveBranch(client, ontologyId, branchRef);
  const currentRevision = await revision(client, ontologyId, branch.branch_id);
  const ws = await client.query(
    `SELECT * FROM ontology_working_state WHERE ontology_id=$1 AND branch_id=$2 AND principal_id=$3`,
    [ontologyId, branch.branch_id, principalId],
  );
  const rows = ws.rowCount ? await client.query(
    `SELECT * FROM ontology_working_change WHERE working_state_id=$1 ORDER BY created_at, change_id`, [ws.rows[0].working_state_id],
  ) : { rows: [] as Record<string, unknown>[] };
  const storedChanges = rows.rows.map((row) => rowToChange(row as Record<string, unknown>));
  const changes = storedChanges.map((change) => ({ ...change, issues: resolveCompositeIssues(change, change.issues, storedChanges) }));
  const uniqueIssues = new Map<string, ValidationIssue>();
  for (const change of changes) for (const value of change.issues) uniqueIssues.set(value.key, value);
  const resourceKeys = new Set(changes.map((change) => `${change.resourceKind}:${change.resourceId}`));
  const protectedResult = changes.length ? await client.query(
    `SELECT p.resource_kind, p.resource_id, p.policy_rid
       FROM ontology_resource_protection p
      WHERE p.ontology_id=$1 AND p.protected=true
        AND (p.resource_kind, p.resource_id) IN
            (SELECT resource_kind, resource_id FROM ontology_working_change WHERE working_state_id=$2)`,
    [ontologyId, ws.rows[0].working_state_id],
  ) : { rows: [] as Record<string, unknown>[] };
  const baseRevision = ws.rowCount ? Number(ws.rows[0].base_revision) : currentRevision;
  return {
    workingStateId: ws.rows[0]?.working_state_id ?? null, ontologyId, branchId: branch.branch_id,
    branchName: branch.name, baseRevision, currentRevision, stale: baseRevision !== currentRevision,
    changes, resourceCount: resourceKeys.size, editCount: resourceKeys.size,
    errorCount: [...uniqueIssues.values()].filter((value) => value.severity === "error").length,
    warningCount: [...uniqueIssues.values()].filter((value) => value.severity === "warning").length,
    protectedResources: protectedResult.rows.map((row) => ({ resourceKind: row.resource_kind as OntologyResourceKind,
      resourceId: String(row.resource_id), policyRid: row.policy_rid == null ? null : String(row.policy_rid) })),
  };
}

export async function getWorkingState(ontologyId: string, principalId: string, branchRef?: string | null) {
  const client = await getClient();
  try { return await reviewWithClient(client, ontologyId, principalId, branchRef); }
  finally { client.release(); }
}

export async function stageChange(ontologyId: string, principalId: string, branchRef: string | null | undefined, input: WorkingChangeInput) {
  if (!input.changeId?.trim() || !RESOURCE_KINDS.has(input.resourceKind) || !OPERATIONS.has(input.operation) || !input.summary?.trim())
    throw appError("VALIDATION_FAILED", "changeId, supported resourceKind/operation, and summary are required.");
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const branch = await resolveBranch(client, ontologyId, branchRef);
    if (branch.status !== "OPEN") throw appError("BRANCH_NOT_OPEN", `Branch '${branch.name}' is ${branch.status}.`);
    const currentRevision = await revision(client, ontologyId, branch.branch_id);
    const ws = await client.query(
      `INSERT INTO ontology_working_state (ontology_id, branch_id, principal_id, base_revision)
       VALUES ($1,$2,$3,$4) ON CONFLICT (ontology_id,branch_id,principal_id)
       DO UPDATE SET updated_at=now() RETURNING *`, [ontologyId, branch.branch_id, principalId, currentRevision],
    );
    const prior = await client.query(`SELECT * FROM ontology_working_change WHERE change_id=$1 AND working_state_id=$2`,
      [input.changeId, ws.rows[0].working_state_id]);
    const baseSnapshot = prior.rowCount ? parseJson(prior.rows[0].base_snapshot, null) : await branchSnapshot(client, ontologyId, branch, input.resourceKind, input.resourceId);
    const baseRevision = prior.rows[0]?.base_revision ?? (baseSnapshot && typeof baseSnapshot === "object" && "version" in (baseSnapshot as object)
      ? String((baseSnapshot as Record<string, unknown>).version) : String(currentRevision));
    let patch = {
      ...(prior.rowCount ? parseJson<Record<string, unknown>>(prior.rows[0].patch, {}) : {}),
      ...(input.patch ?? {}),
    };
    if (input.operation === "modify" && baseSnapshot && typeof baseSnapshot === "object") {
      for (const [key, value] of Object.entries(patch))
        if (stable(value) === stable((baseSnapshot as Record<string, unknown>)[key])) delete patch[key];
      if (!Object.keys(patch).length && input.proposedValue === undefined) {
        await client.query(`DELETE FROM ontology_working_change WHERE change_id=$1 AND working_state_id=$2`, [input.changeId, ws.rows[0].working_state_id]);
        await client.query(`UPDATE ontology_working_state SET revision=revision+1,updated_at=now() WHERE working_state_id=$1`, [ws.rows[0].working_state_id]);
        await client.query("COMMIT");
        return getWorkingState(ontologyId, principalId, branch.branch_id);
      }
    }
    const effective = { ...(baseSnapshot && typeof baseSnapshot === "object" ? baseSnapshot as Record<string, unknown> : {}),
      ...(input.proposedValue && typeof input.proposedValue === "object" ? input.proposedValue as Record<string, unknown> : {}), ...patch };
    if (input.resourceKind === "datasource") await resolveCanonicalFoundryDatasource(client, effective);
    const issues = [...validateShape({ ...input, patch }, effective), ...await ensureUnique(client, ontologyId, input, effective)];
    await client.query(
      `INSERT INTO ontology_working_change
       (change_id,working_state_id,resource_kind,resource_id,operation,base_snapshot,base_revision,
        proposed_value,patch,summary,dependencies,issues,destructive,resource_url,acknowledged)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (working_state_id,change_id) DO UPDATE SET operation=EXCLUDED.operation,proposed_value=EXCLUDED.proposed_value,
        patch=EXCLUDED.patch,summary=EXCLUDED.summary,dependencies=EXCLUDED.dependencies,issues=EXCLUDED.issues,
        destructive=EXCLUDED.destructive,resource_url=EXCLUDED.resource_url,acknowledged=EXCLUDED.acknowledged,updated_at=now()`,
      [input.changeId, ws.rows[0].working_state_id, input.resourceKind, input.resourceId, input.operation,
       JSON.stringify(baseSnapshot), baseRevision, input.proposedValue === undefined ? null : JSON.stringify(input.proposedValue),
       Object.keys(patch).length ? JSON.stringify(patch) : null, input.summary, input.dependencies ?? [], JSON.stringify(issues),
       input.destructive ? JSON.stringify(input.destructive) : null, input.resourceUrl ?? null, input.acknowledged ?? false],
    );
    await client.query(`UPDATE ontology_working_state SET revision=revision+1,updated_at=now() WHERE working_state_id=$1`, [ws.rows[0].working_state_id]);
    await client.query("COMMIT");
    return getWorkingState(ontologyId, principalId, branch.branch_id);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function discardResource(ontologyId: string, principalId: string, branchRef: string | null | undefined, kind: OntologyResourceKind, resourceId: string) {
  const client = await getClient();
  try {
    await client.query("BEGIN"); const branch = await resolveBranch(client, ontologyId, branchRef);
    await client.query(`DELETE FROM ontology_working_change c USING ontology_working_state w
      WHERE c.working_state_id=w.working_state_id AND w.ontology_id=$1 AND w.branch_id=$2 AND w.principal_id=$3
        AND c.resource_kind=$4 AND c.resource_id=$5`, [ontologyId, branch.branch_id, principalId, kind, resourceId]);
    await client.query("COMMIT"); return getWorkingState(ontologyId, principalId, branch.branch_id);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function discardChange(ontologyId: string, principalId: string, branchRef: string | null | undefined, changeId: string) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const branch = await resolveBranch(client, ontologyId, branchRef);
    await client.query(`DELETE FROM ontology_working_change c USING ontology_working_state w
      WHERE c.working_state_id=w.working_state_id AND w.ontology_id=$1 AND w.branch_id=$2 AND w.principal_id=$3
        AND c.change_id=$4`, [ontologyId, branch.branch_id, principalId, changeId]);
    await client.query("COMMIT");
    return getWorkingState(ontologyId, principalId, branch.branch_id);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function discardAll(ontologyId: string, principalId: string, branchRef?: string | null) {
  const client = await getClient();
  try { const branch = await resolveBranch(client, ontologyId, branchRef); await client.query(
    `DELETE FROM ontology_working_state WHERE ontology_id=$1 AND branch_id=$2 AND principal_id=$3`,
    [ontologyId, branch.branch_id, principalId]); return getWorkingState(ontologyId, principalId, branch.branch_id);
  } finally { client.release(); }
}

export async function acknowledgeChange(ontologyId: string, principalId: string, branchRef: string | null | undefined, changeId: string, acknowledged: boolean) {
  const client = await getClient();
  try { const branch = await resolveBranch(client, ontologyId, branchRef); await client.query(
    `UPDATE ontology_working_change c SET acknowledged=$5,updated_at=now() FROM ontology_working_state w
      WHERE c.change_id=$4 AND c.working_state_id=w.working_state_id AND w.ontology_id=$1 AND w.branch_id=$2 AND w.principal_id=$3`,
    [ontologyId, branch.branch_id, principalId, changeId, acknowledged]); return getWorkingState(ontologyId, principalId, branch.branch_id);
  } finally { client.release(); }
}

/**
 * Rebase a working state onto the latest schema revision without publishing.
 * Non-overlapping changes update automatically. Overlapping fields require an
 * explicit latest/working/manual resolution before the base revision moves.
 */
export async function updateWorkingState(
  ontologyId: string,
  principalId: string,
  branchRef?: string | null,
  resolutions: Record<string, ConflictResolution> = {},
): Promise<{ review: WorkingStateReview; conflicts: WorkingStateConflict[] }> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const branch = await resolveBranch(client, ontologyId, branchRef);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ontology-working-state:${ontologyId}:${branch.branch_id}:${principalId}`]);
    const currentRevision = await revision(client, ontologyId, branch.branch_id);
    const ws = await client.query(
      `SELECT * FROM ontology_working_state WHERE ontology_id=$1 AND branch_id=$2 AND principal_id=$3 FOR UPDATE`,
      [ontologyId, branch.branch_id, principalId],
    );
    if (!ws.rowCount) {
      await client.query("COMMIT");
      return { review: await getWorkingState(ontologyId, principalId, branch.branch_id), conflicts: [] };
    }
    const rows = await client.query(
      `SELECT * FROM ontology_working_change WHERE working_state_id=$1 ORDER BY created_at,change_id FOR UPDATE`,
      [ws.rows[0].working_state_id],
    );
    const conflicts: WorkingStateConflict[] = [];
    const updates: Array<{ change: WorkingChange; latest: unknown; patch: Record<string, unknown> }> = [];
    const remove = new Set<string>();
    for (const row of rows.rows) {
      const change = rowToChange(row as Record<string, unknown>);
      const latest = await branchSnapshot(client, ontologyId, branch, change.resourceKind, change.resourceId);
      const base = change.baseSnapshot && typeof change.baseSnapshot === "object" ? change.baseSnapshot as Record<string, unknown> : {};
      const latestValue = latest && typeof latest === "object" ? latest as Record<string, unknown> : {};
      const patch = { ...(change.patch ?? {}) };
      const working = { ...(change.proposedValue && typeof change.proposedValue === "object" ? change.proposedValue as Record<string, unknown> : {}), ...patch };
      if (change.operation === "create" && latest !== null) {
        const key = `${change.changeId}:__resource`;
        const resolution = resolutions[key];
        if (!resolution) conflicts.push({ key, changeId: change.changeId, resourceKind: change.resourceKind,
          resourceId: change.resourceId, field: "__resource", baseValue: null, latestValue: latest, workingValue: working });
        else if (resolution.choice === "latest") remove.add(change.changeId);
      } else if (change.operation === "delete" && stable(base) !== stable(latest)) {
        const key = `${change.changeId}:__resource`;
        const resolution = resolutions[key];
        if (!resolution) conflicts.push({ key, changeId: change.changeId, resourceKind: change.resourceKind,
          resourceId: change.resourceId, field: "__resource", baseValue: base, latestValue: latest, workingValue: null });
        else if (resolution.choice === "latest") remove.add(change.changeId);
      } else {
        for (const [field, workingValue] of Object.entries(working)) {
          if (stable(base[field]) === stable(latestValue[field]) || stable(workingValue) === stable(latestValue[field])) continue;
          const key = `${change.changeId}:${field}`;
          const resolution = resolutions[key];
          if (!resolution) {
            conflicts.push({ key, changeId: change.changeId, resourceKind: change.resourceKind,
              resourceId: change.resourceId, field, baseValue: base[field], latestValue: latestValue[field], workingValue });
          } else if (resolution.choice === "latest") delete patch[field];
          else if (resolution.choice === "manual") patch[field] = resolution.value;
        }
      }
      updates.push({ change, latest, patch });
    }
    if (conflicts.length) {
      await client.query("ROLLBACK");
      return { review: await getWorkingState(ontologyId, principalId, branch.branch_id), conflicts };
    }
    for (const { change, latest, patch } of updates) {
      if (remove.has(change.changeId) || (change.operation === "modify" && !Object.keys(patch).length && change.proposedValue === undefined)) {
        await client.query(`DELETE FROM ontology_working_change WHERE working_state_id=$1 AND change_id=$2`, [ws.rows[0].working_state_id, change.changeId]);
      } else {
        await client.query(`UPDATE ontology_working_change SET base_snapshot=$3,base_revision=$4,patch=$5,updated_at=now()
          WHERE working_state_id=$1 AND change_id=$2`, [ws.rows[0].working_state_id, change.changeId,
          JSON.stringify(latest), hash(latest), Object.keys(patch).length ? JSON.stringify(patch) : null]);
      }
    }
    await client.query(`UPDATE ontology_working_state SET base_revision=$2,revision=revision+1,updated_at=now() WHERE working_state_id=$1`,
      [ws.rows[0].working_state_id, currentRevision]);
    await client.query("COMMIT");
    return { review: await getWorkingState(ontologyId, principalId, branch.branch_id), conflicts: [] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export function orderWorkingChanges(changes: WorkingChange[]): WorkingChange[] {
  const byId = new Map(changes.map((change) => [change.changeId, change]));
  const seen = new Set<string>(); const visiting = new Set<string>(); const result: WorkingChange[] = [];
  const order: Record<OntologyChangeOperation, number> = { create: 0, modify: 1, bind: 2, migrate: 3, index: 4, restore: 5, other: 6, delete: 7 };
  const visit = (change: WorkingChange) => {
    if (seen.has(change.changeId)) return;
    if (visiting.has(change.changeId)) throw appError("CHANGE_DEPENDENCY_CYCLE", `Dependency cycle at '${change.changeId}'.`);
    visiting.add(change.changeId);
    for (const dependency of change.dependencies ?? []) { const value = byId.get(dependency); if (value) visit(value); }
    visiting.delete(change.changeId); seen.add(change.changeId); result.push(change);
  };
  [...changes].sort((a,b) => order[a.operation]-order[b.operation] || a.changeId.localeCompare(b.changeId)).forEach(visit);
  return result;
}

const OBJECT_COLUMNS: Record<string,string> = { apiName:"api_name",displayName:"display_name",pluralName:"plural_name",description:"description",
  aliases:"aliases",icon:"icon",iconColor:"icon_color",status:"status",visibility:"visibility",editsViaActionsOnly:"edits_via_actions_only" };
const PROPERTY_COLUMNS: Record<string,string> = { displayName:"display_name",description:"description",isRequired:"is_required",ordinal:"ordinal",
  conditionalFormatting:"conditional_formatting",visibility:"visibility",inlineEditActionId:"inline_edit_action_id",baseType:"base_type",isArray:"is_array" };
const ACTION_COLUMNS: Record<string,string> = { apiName:"api_name",displayName:"display_name",description:"description",icon:"icon_name",iconColor:"icon_color",
  saveLocationRid:"save_location_rid",parameters:"parameters",rules:"rules",submissionCriteria:"submission_criteria",sideEffects:"side_effects",
  writebackConfig:"writeback_config",securitySettings:"security_settings",semanticsVersion:"semantics_version",executionMode:"execution_mode",
  functionConfig:"function_config",deletePolicy:"delete_policy",isEnabled:"is_enabled",formContent:"form_content" };
const LINK_COLUMNS: Record<string,string> = { apiName:"api_name",displayName:"display_name",description:"description",cardinality:"cardinality",
  resolverConfig:"resolver_config",status:"status",visibility:"visibility",sourcePropertyId:"source_property_id",targetPropertyId:"target_property_id",
  joinTableFilePath:"join_table_file_path",joinTableSourceColumn:"join_table_source_column",joinTableTargetColumn:"join_table_target_column",
  isBidirectional:"is_bidirectional",storageBackend:"storage_backend",violationPolicy:"violation_policy",reverseApiName:"reverse_api_name",
  reverseDisplayName:"reverse_display_name",reverseDescription:"reverse_description",reverseVisible:"reverse_visible",
  reversePropertyProjection:"reverse_property_projection",reverseActionsEnabled:"reverse_actions_enabled",
  mandatoryControlPropertyId:"mandatory_control_property_id",mcpPropagationMode:"mcp_propagation_mode",mcpRequiredCount:"mcp_required_count" };

async function dynamicUpdate(client: PoolClient, table: string, columns: Record<string,string>, patch: Record<string,unknown>, where: string, ids: unknown[]) {
  const entries = Object.entries(patch).filter(([key]) => columns[key]);
  if (!entries.length) return;
  const values = entries.map(([,value]) => value != null && typeof value === "object" ? JSON.stringify(value) : value);
  const set = entries.map(([key], index) => `${columns[key]}=$${index+1}`).join(",");
  await client.query(`UPDATE ${table} SET ${set},updated_at=now() WHERE ${where}`, [...values, ...ids]);
}

async function findObjectType(client: PoolClient, ontologyId: string, id: string) {
  const found = await client.query(`SELECT * FROM object_type WHERE ontology_id=$1 AND (api_name=$2 OR object_type_id::text=$2)`, [ontologyId,id]);
  if (!found.rowCount) throw appError("OBJECT_TYPE_NOT_FOUND", `Object type '${id}' was not found.`);
  return found.rows[0] as Record<string,unknown>;
}

async function applyChange(client: PoolClient, ontologyId: string, commitId: string, change: WorkingChange) {
  const proposed = (change.proposedValue && typeof change.proposedValue === "object" ? change.proposedValue : {}) as Record<string,unknown>;
  const patch = (change.patch ?? {}) as Record<string,unknown>;
  const value = { ...proposed, ...patch };
  if (change.resourceKind === "objectType") {
    if (change.operation === "create") {
      const inserted = await client.query(`INSERT INTO object_type
          (object_type_id,ontology_id,api_name,display_name,plural_name,description,icon,icon_color,status,created_by)
          VALUES (COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING object_type_id`,
          [value.objectTypeId ?? null,ontologyId,value.apiName,value.displayName,value.pluralName ?? null,
          value.description ?? null,value.icon ?? "cube",value.iconColor ?? "#1565C0",value.status ?? "experimental", "ontology-working-state"])
        .catch((error: unknown) => {
          const conflict = objectTypeCreateConflict(error, value);
          if (conflict) throw appError(conflict.code, conflict.message);
          throw error;
        });
      const objectTypeId = inserted.rows[0].object_type_id;
      await client.query(`INSERT INTO funnel_state (object_type_id,status) VALUES ($1,'not_indexed') ON CONFLICT DO NOTHING`, [objectTypeId]);
      for (const [index, property] of ((value.properties as Array<Record<string,unknown>>) ?? []).entries()) {
        await client.query(`INSERT INTO property (object_type_id,api_name,display_name,base_type,description,is_required,is_array,ordinal,conditional_formatting)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [objectTypeId,property.apiName,property.displayName,property.baseType,property.description ?? null,
          property.isRequired ?? false,String(property.baseType).endsWith("_array"),property.ordinal ?? index,
          property.conditionalFormatting ? JSON.stringify(property.conditionalFormatting) : null]);
      }
      for (const [column,key] of [["primary_key_property_id","primaryKeyProperty"],["title_property_id","titleProperty"]] as const)
        if (value[key]) await client.query(`UPDATE object_type SET ${column}=(SELECT property_id FROM property WHERE object_type_id=$1 AND api_name=$2) WHERE object_type_id=$1`, [objectTypeId,value[key]]);
      for (const implementation of ((value.implementedInterfaces as Array<Record<string,unknown>>) ?? [])) {
        const interfaceApiName = String(implementation.interfaceApiName ?? "");
        const interfaceRow = await client.query(`SELECT interface_id FROM interface WHERE api_name=$1`, [interfaceApiName]);
        if (!interfaceRow.rowCount) throw appError("INTERFACE_NOT_FOUND", `Interface '${interfaceApiName}' was not found.`);
        await client.query(`INSERT INTO object_type_interface (object_type_id,interface_id,property_mapping) VALUES ($1,$2,$3)
          ON CONFLICT (object_type_id,interface_id) DO UPDATE SET property_mapping=EXCLUDED.property_mapping`,
          [objectTypeId,interfaceRow.rows[0].interface_id,JSON.stringify(implementation.propertyMapping ?? {})]);
      }
    } else if (change.operation === "delete") {
      await client.query(`DELETE FROM object_type WHERE ontology_id=$1 AND (api_name=$2 OR object_type_id::text=$2)`, [ontologyId,change.resourceId]);
    } else if (change.operation === "index") {
      const objectType = await findObjectType(client,ontologyId,change.resourceId);
      await sendSignal({ client, ontologyId, objectTypeApiName: String(objectType.api_name), signalType: "schemaChanged",
        payload: { force: Boolean(value.force), commitId }, fingerprint: `ontology-commit:${commitId}:${change.changeId}` });
    } else {
      await dynamicUpdate(client,"object_type",OBJECT_COLUMNS,value,`ontology_id=$${Object.keys(value).filter(k=>OBJECT_COLUMNS[k]).length+1} AND (api_name=$${Object.keys(value).filter(k=>OBJECT_COLUMNS[k]).length+2} OR object_type_id::text=$${Object.keys(value).filter(k=>OBJECT_COLUMNS[k]).length+2})`,[ontologyId,change.resourceId]);
    }
  } else if (change.resourceKind === "property") {
    const split=change.resourceId.lastIndexOf("."); const objectId=change.resourceId.slice(0,split); const propertyId=change.resourceId.slice(split+1);
    const objectType=await findObjectType(client,ontologyId,objectId); const objectTypeId=objectType.object_type_id;
    if (change.operation === "create") await client.query(`INSERT INTO property (object_type_id,api_name,display_name,base_type,description,is_required,is_array,ordinal,conditional_formatting)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[objectTypeId,value.apiName,value.displayName,value.baseType,value.description ?? null,value.isRequired ?? false,
      String(value.baseType).endsWith("_array"),value.ordinal ?? 0,value.conditionalFormatting ? JSON.stringify(value.conditionalFormatting):null]);
    else if (change.operation === "delete") await client.query(`DELETE FROM property WHERE object_type_id=$1 AND (api_name=$2 OR property_id::text=$2)`,[objectTypeId,propertyId]);
    else {
      const primaryKey = typeof value.primaryKey === "string" ? value.primaryKey : value.primaryKey === true ? propertyId : null;
      const titleProperty = typeof value.titleProperty === "string" ? value.titleProperty : value.titleKey === true ? propertyId : null;
      if (primaryKey) await client.query(`UPDATE object_type SET primary_key_property_id=(SELECT property_id FROM property WHERE object_type_id=$1 AND (api_name=$2 OR property_id::text=$2)) WHERE object_type_id=$1`,[objectTypeId,primaryKey]);
      if (titleProperty) await client.query(`UPDATE object_type SET title_property_id=(SELECT property_id FROM property WHERE object_type_id=$1 AND (api_name=$2 OR property_id::text=$2)) WHERE object_type_id=$1`,[objectTypeId,titleProperty]);
      if (change.operation === "migrate" && value.baseType) value.isArray = String(value.baseType).endsWith("_array");
      await dynamicUpdate(client,"property",PROPERTY_COLUMNS,value,`object_type_id=$${Object.keys(value).filter(k=>PROPERTY_COLUMNS[k]).length+1} AND (api_name=$${Object.keys(value).filter(k=>PROPERTY_COLUMNS[k]).length+2} OR property_id::text=$${Object.keys(value).filter(k=>PROPERTY_COLUMNS[k]).length+2})`,[objectTypeId,propertyId]);
    }
  } else if (change.resourceKind === "actionType") {
    if (change.operation === "delete") await client.query(`DELETE FROM action_type WHERE ontology_id=$1 AND (api_name=$2 OR action_type_id::text=$2)`,[ontologyId,change.resourceId]);
    else if (change.operation === "create") await client.query(`INSERT INTO action_type
      (ontology_id,api_name,display_name,description,icon_name,icon_color,save_location_rid,parameters,rules,submission_criteria,side_effects,
       writeback_config,security_settings,semantics_version,execution_mode,function_config,delete_policy,is_enabled,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'ontology-working-state')`,[ontologyId,value.apiName,value.displayName,
      value.description ?? "",value.icon ?? value.iconName ?? "manually-entered-data",value.iconColor ?? "#1A2230",
      value.saveLocationRid ?? null,JSON.stringify(value.parameters ?? []),JSON.stringify(value.rules ?? []),value.submissionCriteria ? JSON.stringify(value.submissionCriteria):null,
      value.sideEffects ? JSON.stringify(value.sideEffects):null,value.writebackConfig ? JSON.stringify(value.writebackConfig):null,
      value.securitySettings ? JSON.stringify(value.securitySettings):null,value.semanticsVersion ?? 1,value.executionMode ?? "declarative",
      value.functionConfig ? JSON.stringify(value.functionConfig):null,value.deletePolicy ?? "legacy_unchecked",value.isEnabled ?? true]);
    else await dynamicUpdate(client,"action_type",ACTION_COLUMNS,value,`ontology_id=$${Object.keys(value).filter(k=>ACTION_COLUMNS[k]).length+1} AND (api_name=$${Object.keys(value).filter(k=>ACTION_COLUMNS[k]).length+2} OR action_type_id::text=$${Object.keys(value).filter(k=>ACTION_COLUMNS[k]).length+2})`,[ontologyId,change.resourceId]);
  } else if (change.resourceKind === "linkType") {
    if (change.operation === "delete") await client.query(`DELETE FROM link_type WHERE ontology_id=$1 AND (api_name=$2 OR link_type_id::text=$2)`,[ontologyId,change.resourceId]);
    else if (change.operation === "create") {
      const source = await findObjectType(client,ontologyId,String(value.sourceObjectTypeId ?? value.sourceObjectType));
      const target = await findObjectType(client,ontologyId,String(value.targetObjectTypeId ?? value.targetObjectType));
      const resolveProperty = async (objectTypeId: unknown, explicit: unknown, apiName: unknown) => {
        if (explicit) {
          const found=await client.query(`SELECT property_id FROM property WHERE object_type_id=$1 AND (property_id::text=$2 OR api_name=$2)`,[objectTypeId,String(explicit)]);
          return found.rows[0]?.property_id ?? null;
        }
        if (!apiName) return null;
        const found=await client.query(`SELECT property_id FROM property WHERE object_type_id=$1 AND api_name=$2`,[objectTypeId,String(apiName)]);
        return found.rows[0]?.property_id ?? null;
      };
      const sourcePropertyId=await resolveProperty(source.object_type_id,value.sourcePropertyId,value.sourcePropertyApiName);
      const targetPropertyId=await resolveProperty(target.object_type_id,value.targetPropertyId,value.targetPropertyApiName);
      await client.query(`INSERT INTO link_type
        (ontology_id,api_name,display_name,description,cardinality,source_object_type,target_object_type,source_property_id,target_property_id,
         join_table_file_path,join_table_source_column,join_table_target_column,is_bidirectional,storage_backend,violation_policy,
         reverse_api_name,reverse_display_name,reverse_description,reverse_visible,reverse_property_projection,reverse_actions_enabled,
         mandatory_control_property_id,mcp_propagation_mode,mcp_required_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [ontologyId,value.apiName,value.displayName,value.description ?? null,value.cardinality,source.object_type_id,target.object_type_id,sourcePropertyId,targetPropertyId,
        value.joinTableFilePath ?? null,value.joinTableSourceColumn ?? null,value.joinTableTargetColumn ?? null,value.isBidirectional ?? false,
        value.storageBackend ?? "csv_legacy",value.violationPolicy ?? "warn",value.reverseApiName ?? null,value.reverseDisplayName ?? null,
        value.reverseDescription ?? null,value.reverseVisible ?? true,value.reversePropertyProjection ? JSON.stringify(value.reversePropertyProjection):null,
        value.reverseActionsEnabled ?? true,value.mandatoryControlPropertyId ?? null,value.mcpPropagationMode ?? "union",value.mcpRequiredCount ?? 1]);
    }
    else await dynamicUpdate(client,"link_type",LINK_COLUMNS,value,`ontology_id=$${Object.keys(value).filter(k=>LINK_COLUMNS[k]).length+1} AND (api_name=$${Object.keys(value).filter(k=>LINK_COLUMNS[k]).length+2} OR link_type_id::text=$${Object.keys(value).filter(k=>LINK_COLUMNS[k]).length+2})`,[ontologyId,change.resourceId]);
  } else if (change.resourceKind === "groupMembership") {
    const groupId=String(value.groupId ?? change.resourceId.split(":")[0]); const objectTypeId=String(value.objectTypeId ?? change.resourceId.split(":")[1]);
    if (value.member === false || change.operation === "delete") await client.query(`DELETE FROM object_type_group_member WHERE group_id=$1 AND object_type_id=$2`,[groupId,objectTypeId]);
    else await client.query(`INSERT INTO object_type_group_member (group_id,object_type_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[groupId,objectTypeId]);
  } else if (change.resourceKind === "datasource") {
    const objectType=await findObjectType(client,ontologyId,change.resourceId);
    const datasourceId=String(value.foundryDatasetId ?? value.datasourceRid ?? "");
    const canonical=await resolveCanonicalFoundryDatasource(client,value);
    const dataset=!canonical && datasourceId ? await client.query(`SELECT name,file_path,mime_type,format FROM foundry_datasets WHERE id::text=$1 LIMIT 1`,[datasourceId]) : null;
    const mappings=Array.isArray(value.propertyMappings)
      ? Object.fromEntries((value.propertyMappings as Array<Record<string,unknown>>).map(mapping=>[String(mapping.targetPropertyId),String(mapping.sourceColumn)]))
      : (value.columnMapping ?? {});
    const datasetName=canonical?.name ?? value.datasetName ?? dataset?.rows[0]?.name ?? datasourceId;
    const baseFilePath=canonical?.filePath ?? String(value.filePath ?? dataset?.rows[0]?.file_path ?? "");
    if (!baseFilePath && !datasourceId) throw appError("DATASOURCE_NOT_FOUND","The bound dataset could not be resolved for this object type.");
    // Mirror datasetDatasourceService's synthetic-path convention:
    // backing_datasource enforces UNIQUE(file_path) (idx_ds_file_path), so
    // every (dataset, object type) pair gets its own derived path. Without
    // this, binding a second object type to a dataset that already backs
    // one fails the whole commit with a raw unique_violation → 409.
    const filePath=`${baseFilePath}#foundry-dataset:${datasourceId}#object-type:${objectType.object_type_id}`;
    const mime=String(dataset?.rows[0]?.mime_type ?? "");
    const fileFormat=canonical?.fileFormat ?? dataset?.rows[0]?.format ?? value.fileFormat ?? (mime.includes("json") ? "json" : mime.includes("parquet") ? "parquet" : "csv");
    const primaryKeyColumn=value.primaryKeyColumn ?? value.primaryKeyMapping;
    const foundryDatasetId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(datasourceId) ? datasourceId : null;
    await client.query(`INSERT INTO backing_datasource (object_type_id,dataset_name,file_path,file_format,column_mapping,primary_key_column,registered_by,foundry_dataset_id)
      VALUES ($1,$2,$3,$4,$5,$6,'ontology-working-state',$7) ON CONFLICT (object_type_id) DO UPDATE SET dataset_name=EXCLUDED.dataset_name,
      file_path=EXCLUDED.file_path,file_format=EXCLUDED.file_format,column_mapping=EXCLUDED.column_mapping,primary_key_column=EXCLUDED.primary_key_column,
      foundry_dataset_id=EXCLUDED.foundry_dataset_id`,
      [objectType.object_type_id,datasetName,filePath,fileFormat,JSON.stringify(mappings),primaryKeyColumn,foundryDatasetId]);
    await sendSignal({ client, ontologyId, objectTypeApiName: String(objectType.api_name), signalType: "schemaChanged",
      payload: { commitId }, fingerprint: `ontology-commit:${commitId}:${change.changeId}` });
  } else if (change.resourceKind === "binding") {
    const mappings=(value.property_mappings as Array<Record<string,unknown>> ?? []);
    const propertyMap=Object.fromEntries(mappings.map(mapping=>[String(mapping.target_property),String(mapping.source_column)]));
    const primary=mappings.find(mapping=>mapping.is_primary_key===true);
    if (!primary) throw appError("INVALID_BINDING", "Exactly one binding property mapping must be primary key.");
    const indexed=mappings.filter(mapping=>mapping.is_indexed===true).map(mapping=>String(mapping.target_property));
    const funnel=await client.query(`INSERT INTO funnel_bindings
      (rid,dataset_rid,object_type_rid,property_map,indexed_properties,pk_column,title_property,mode,status)
      VALUES ('ri.funnel.main.binding.'||gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,'batch','pending') RETURNING rid`,
      [value.dataset_rid,value.object_type_rid,JSON.stringify(propertyMap),JSON.stringify(indexed),primary.source_column,value.title_property ?? null]);
    await client.query(`INSERT INTO ontology_bindings
      (rid,object_type_rid,dataset_rid,funnel_binding_rid,property_map,pk_property,title_property,status,version)
      VALUES ('ri.ontology.main.binding.'||gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,'pending',1)`,
      [value.object_type_rid,value.dataset_rid,funnel.rows[0].rid,JSON.stringify(propertyMap),primary.target_property,value.title_property ?? null]);
  }
  if (!["index"].includes(change.operation)) await client.query(`INSERT INTO ontology_schema_outbox (commit_id,event_key,event_type,payload)
    VALUES ($1,$2,'SCHEMA_CHANGED',$3) ON CONFLICT (commit_id,event_key) DO NOTHING`,[commitId,`${change.changeId}:schema`,JSON.stringify({ontologyId,resourceKind:change.resourceKind,resourceId:change.resourceId})]);
}

async function applyChanges(client: PoolClient, ontologyId: string, commitId: string, changes: WorkingChange[]) {
  for (const change of orderWorkingChanges(changes)) await applyChange(client,ontologyId,commitId,change);
}

export async function commitWorkingState(ontologyId: string, principalId: string, branchRef: string | null | undefined,
  input: { target: "main"|"branch"|"newBranch"; branchName?: string; branchDescription?: string }, idempotencyKey: string) {
  if (!idempotencyKey?.trim()) throw appError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required.");
  // Replay lookup happens BEFORE the empty-state guard so that retrying an
  // already-committed request returns the recorded result instead of
  // NO_PENDING_CHANGES once the working state has been drained.
  const priorCommit=await query(`SELECT * FROM ontology_schema_commit WHERE principal_id=$1 AND idempotency_key=$2`,[principalId,idempotencyKey]);
  const initial=await getWorkingState(ontologyId,principalId,branchRef);
  if (!initial.changes.length) {
    if (priorCommit.rowCount && priorCommit.rows[0].status==="SUCCEEDED") return parseJson(priorCommit.rows[0].response,{});
    throw appError("NO_PENDING_CHANGES","There are no pending Ontology changes.");
  }
  const requestHash=hash({ontologyId,branchId:initial.branchId,input,changes:initial.changes});
  const claimed=await query(`INSERT INTO ontology_schema_commit (ontology_id,branch_id,principal_id,idempotency_key,request_hash,target,status)
    VALUES ($1,$2,$3,$4,$5,$6,'IN_PROGRESS') ON CONFLICT (principal_id,idempotency_key) DO NOTHING RETURNING commit_id`,
    [ontologyId,initial.branchId,principalId,idempotencyKey,requestHash,input.target==="main"?"main":"branch"]);
  let commitId:string;
  if (!claimed.rowCount) {
    const prior=priorCommit;
    if (!prior.rowCount) throw appError("IDEMPOTENCY_CLAIM_LOST","Idempotency claim was lost; retry the save.");
    if (prior.rows[0].request_hash!==requestHash) throw appError("IDEMPOTENCY_KEY_REUSED","Idempotency key was reused with a different change set.");
    if (prior.rows[0].status==="SUCCEEDED") return parseJson(prior.rows[0].response,{});
    if (prior.rows[0].status==="IN_PROGRESS") throw appError("COMMIT_IN_PROGRESS","This idempotent Ontology save is already in progress.");
    commitId=prior.rows[0].commit_id;
  } else commitId=claimed.rows[0].commit_id;
  const client=await getClient();
  try {
    await client.query("BEGIN"); await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`ontology-schema:${ontologyId}:${initial.branchId}`]);
    const review=await reviewWithClient(client,ontologyId,principalId,initial.branchId);
    if (review.stale) throw appError("ONTOLOGY_STALE_BASE","The Ontology changed after this working state was created. Update before saving.");
    // Immediate public mutation APIs remain compatible, so they may change a
    // resource without advancing the schema-gateway revision. Re-read every
    // canonical base under the commit lock to prevent those writes from being
    // overwritten merely because the coarse revision happens to match.
    const freshErrors:string[]=[];
    for (const change of review.changes) {
      const latest=await branchSnapshot(client,ontologyId,{branch_id:review.branchId,name:review.branchName},change.resourceKind,change.resourceId);
      if (change.operation==="create") {
        if (latest != null) throw appError("ONTOLOGY_STALE_BASE",`'${change.resourceId}' was created after this draft started. Update before saving.`);
      } else if (stable(latest)!==stable(change.baseSnapshot)) {
        throw appError("ONTOLOGY_STALE_BASE",`'${change.resourceId}' changed after this draft started. Update before saving.`);
      }
      const proposed=change.proposedValue&&typeof change.proposedValue==="object"?change.proposedValue as Record<string,unknown>:{};
      const effective={...(latest&&typeof latest==="object"?latest as Record<string,unknown>:{}),...proposed,...(change.patch??{})};
      const currentIssues=resolveCompositeIssues(change,[...validateShape(change,effective),...await ensureUnique(client,ontologyId,change,effective)],review.changes);
      freshErrors.push(...currentIssues.filter(value=>value.severity==="error").map(value=>value.message));
    }
    // Blocking decisions use freshly computed issues only — persisted
    // issue rows are stage-time snapshots and may be stale (e.g. after a
    // validator change or base update).
    if (freshErrors.length) throw appError("ONTOLOGY_VALIDATION_FAILED",freshErrors.join(" "));
    const missingAck=review.changes.find(change=>change.destructive?.acknowledgementRequired && !change.acknowledged);
    if (missingAck) throw appError("DESTRUCTIVE_ACKNOWLEDGEMENT_REQUIRED",`Acknowledge '${missingAck.summary}' before saving.`);
    const onMain=review.branchName.toLowerCase()==="main";
    if (onMain && input.target==="main" && review.protectedResources.length)
      throw appError("PROTECTED_RESOURCE_REQUIRES_BRANCH","Protected Ontology resources must be saved to a branch.");
    let targetBranchId=review.branchId; let targetBranchName=review.branchName;
    if (input.target==="newBranch") {
      if (!onMain) throw appError("BRANCH_FROM_MAIN_REQUIRED","New Ontology branches can only be created from main.");
      if (!input.branchName?.trim()) throw appError("VALIDATION_FAILED","branchName is required.");
      const created=await client.query(`INSERT INTO ontology_branch (ontology_id,name,parent_branch_id,created_by) VALUES ($1,$2,$3,$4) RETURNING branch_id,name`,
        [ontologyId,input.branchName.trim(),review.branchId,principalId]); targetBranchId=created.rows[0].branch_id; targetBranchName=created.rows[0].name;
      await client.query(`INSERT INTO ontology_schema_revision (ontology_id,branch_id,revision) VALUES ($1,$2,$3)`,[ontologyId,targetBranchId,review.currentRevision]);
    }
    let newRevision: number;
    if (input.target==="main") {
      await applyChanges(client,ontologyId,commitId,review.changes);
      newRevision=Number((await client.query(`UPDATE ontology_schema_revision SET revision=revision+1,updated_at=now()
        WHERE ontology_id=$1 AND branch_id=$2 RETURNING revision`,[ontologyId,review.branchId])).rows[0].revision);
    } else {
      const next=Number((await client.query(`UPDATE ontology_schema_revision SET revision=revision+1,updated_at=now() WHERE ontology_id=$1 AND branch_id=$2 RETURNING revision`,[ontologyId,targetBranchId])).rows[0].revision);
      await client.query(`INSERT INTO ontology_saved_change_set (ontology_id,branch_id,base_revision,saved_revision,changes,saved_by,commit_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,[ontologyId,targetBranchId,review.baseRevision,next,JSON.stringify(review.changes),principalId,commitId]);
      newRevision=next;
    }
    await client.query(`DELETE FROM ontology_working_state WHERE working_state_id=$1`,[review.workingStateId]);
    const response={commitId,target:input.target==="main"?"main":"branch",branchId:targetBranchId,branchName:targetBranchName,revision:newRevision,committedChangeIds:review.changes.map(c=>c.changeId)};
    await client.query(`UPDATE ontology_schema_commit SET status='SUCCEEDED',response=$2,completed_at=now(),branch_id=$3 WHERE commit_id=$1`,[commitId,JSON.stringify(response),targetBranchId]);
    await client.query("COMMIT"); return response;
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>undefined);
    const code=(error as {code?:string}).code ?? "OntologyMetadata:CommitFailed";
    await query(`UPDATE ontology_schema_commit SET status='FAILED',error_code=$2,completed_at=now() WHERE commit_id=$1`,[commitId,code]).catch(()=>undefined);
    throw error;
  } finally {client.release();}
}

/** Called from branchMergeService inside its existing merge transaction. */
export async function applySavedBranchChangesWithClient(client: PoolClient, ontologyId: string, branchId: string, mergedBy: string) {
  const rows=await client.query(`SELECT * FROM ontology_saved_change_set WHERE ontology_id=$1 AND branch_id=$2 ORDER BY saved_revision,created_at FOR UPDATE`,[ontologyId,branchId]);
  if (!rows.rowCount) return 0;
  const mergeCommit=await client.query(`INSERT INTO ontology_schema_commit (ontology_id,branch_id,principal_id,idempotency_key,request_hash,target,status)
    VALUES ($1,$2,$3,$4,$5,'main','IN_PROGRESS') ON CONFLICT (principal_id,idempotency_key) DO UPDATE SET request_hash=EXCLUDED.request_hash RETURNING commit_id`,
    [ontologyId,branchId,mergedBy,`merge:${branchId}`,hash(rows.rows.map(row=>row.changes))]);
  let count=0;
  for(const row of rows.rows){
    const changes=parseJson<WorkingChange[]>(row.changes,[]);
    for (const change of orderWorkingChanges(changes)) {
      const latest=await snapshot(client,ontologyId,change.resourceKind,change.resourceId);
      if (change.operation==="create" ? latest!=null : stable(latest)!==stable(change.baseSnapshot))
        throw appError("ONTOLOGY_MERGE_CONFLICT",`'${change.resourceId}' changed on main after the branch forked.`);
      await applyChange(client,ontologyId,mergeCommit.rows[0].commit_id,change);
      count+=1;
    }
  }
  const main=await resolveBranch(client,ontologyId,"main");
  await client.query(`UPDATE ontology_schema_revision SET revision=revision+1,updated_at=now() WHERE ontology_id=$1 AND branch_id=$2`,[ontologyId,main.branch_id]);
  await client.query(`UPDATE ontology_schema_commit SET status='SUCCEEDED',response=$2,completed_at=now() WHERE commit_id=$1`,[mergeCommit.rows[0].commit_id,JSON.stringify({mergedBranchId:branchId,mergedChangeCount:count})]);
  return count;
}
