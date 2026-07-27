// ---------------------------------------------------------------------------
// Webhook Definition Model
//
// CRUD + lookup helpers for the `webhook_definition` table created by
// migration 129. A webhook definition is the governed, versioned,
// immutable-after-publish webhook registry row that an Action Type
// references by `(ontology_id, name, version)` from its `side_effects`
// (Phase 5) or `writeback_config` (Phase 4).
//
// Phase 3 ships the model + route CRUD so FE authoring lands. Phase 4
// (writeback pre-edit stage) and Phase 5 (durable outbox worker) consume
// the registry through this same model layer; the model's `getByApiName`
// is the canonical read path used at execution time.
//
// Versioning is monotonic by `(ontology_id, name)`. A new
// `(ontology_id, name, version)` row is INSERTed on every configuration
// change rather than UPDATEd in place (`updateWebhookDefinition` creates
// a new version). This makes the action_type → webhook reference
// immutable for the life of the action type — editing webhook config
// never silently mutates the meaning of a previously-saved
// action type's binding.
//
// Plaintext credentials, bearer tokens, API keys, and signed headers
// are NEVER persisted. They live in Tellus's secrets manager and are
// referenced via `webhook_secret_reference` rows (one webhook version
// may have multiple secret references — e.g. one for the auth header,
// one for a signing key).
// ---------------------------------------------------------------------------

import { query, withTransaction } from "../db";
import type { PoolClient } from "pg";
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type WebhookStatus = "draft" | "active" | "disabled";

export interface WebhookDefinitionRow {
  webhook_id: string;
  ontology_id: string;
  name: string;
  version: number;
  description: string | null;
  status: WebhookStatus;
  method: HttpMethod;
  endpoint_config: Record<string, unknown>;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown> | null;
  authentication_config: Record<string, unknown>;
  timeout_ms: number;
  max_response_bytes: number;
  retry_policy: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateWebhookDefinitionInput {
  /** Stable, ontology-scoped name. Immutable identifier; bumping version. */
  name: string;
  displayName?: string;
  description?: string | null;
  status?: WebhookStatus;
  method: HttpMethod;
  endpointConfig?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  authenticationConfig: Record<string, unknown>;
  /** Defaults to 30000 (30s). Bounded CHECK in DB is 100..300000. */
  timeoutMs?: number;
  /** Defaults to 1024 * 1024 (1 MiB). Bounded CHECK in DB is 0..10485760. */
  maxResponseBytes?: number;
  retryPolicy?: Record<string, unknown> | null;
  createdBy: string;
}

export interface UpdateWebhookDefinitionInput {
  displayName?: string;
  description?: string | null;
  status?: WebhookStatus;
  method?: HttpMethod;
  endpointConfig?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  authenticationConfig?: Record<string, unknown>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  retryPolicy?: Record<string, unknown> | null;
  /**
   * When true, persist the new field values as a NEW
   * `(ontology_id, name, <current_version + 1>)` row. The action_type →
   * webhook binding refers to the exact version — older versions stay
   * immutable so editing config never mutates the historical meaning of
   * a previously-saved action type. Phase 3 enforces bumpVersion=true
   * at the route layer; structural in-place updates (no version bump)
   * are an internal-only option kept here for the secre-read case where
   * configs are reconciled.
   */
  bumpVersion?: boolean;
  updatedBy?: string;
}

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const STATUSES: WebhookStatus[] = ["draft", "active", "disabled"];

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createWebhookDefinition(
  ontologyId: string,
  input: CreateWebhookDefinitionInput,
): Promise<WebhookDefinitionRow> {
  // Validate input shape (DB CHECKs validate the runtime constraints
  // but a friendlier application-level error is preferable for the
  // caller).
  if (!input.name || typeof input.name !== "string") {
    throw appError("VALIDATION_FAILED", "name is required.");
  }
  if (!/^[A-Z][a-zA-Z0-9]*$/.test(input.name)) {
    throw appError("VALIDATION_FAILED", `name '${input.name}' must be UpperCamelCase (^[A-Z][a-zA-Z0-9]*$).`);
  }
  if (!input.method || !HTTP_METHODS.includes(input.method)) {
    throw appError("VALIDATION_FAILED", `method '${input.method}' must be one of: ${HTTP_METHODS.join(", ")}.`);
  }
  let status: WebhookStatus = input.status ?? "draft";
  if (!STATUSES.includes(status)) {
    throw appError("VALIDATION_FAILED", `status '${status}' must be one of: ${STATUSES.join(", ")}.`);
  }
  const timeoutMs = input.timeoutMs ?? 30000;
  if (typeof timeoutMs !== "number" || timeoutMs < 100 || timeoutMs > 300000) {
    throw appError("VALIDATION_FAILED", "timeoutMs must be 100..300000 ms.");
  }
  const maxResponseBytes = input.maxResponseBytes ?? 1024 * 1024;
  if (typeof maxResponseBytes !== "number" || maxResponseBytes < 0 || maxResponseBytes > 10485760) {
    throw appError("VALIDATION_FAILED", "maxResponseBytes must be 0..10485760 bytes.");
  }

  // Check for an existing draft/active version with the same name — the
  // DB's uq_webhook_definition_live_name partial unique index catches
  // this; we pre-check for the friendlier error message.
  const existing = await query(
    "SELECT version FROM webhook_definition WHERE ontology_id = $1 AND name = $2 AND status IN ('draft','active')",
    [ontologyId, input.name],
  );
  if (existing.rows.length > 0) {
    throw appError(
      "WEBHOOK_ALREADY_EXISTS",
      `Webhook '${input.name}' already exists with status draft/active (v${existing.rows[0].version}). Update it to bump the version (or DELETE first to recreate).`,
    );
  }

  // Compute the next version: max(existing versions) + 1, or 1 if none.
  const maxVersionRes = await query(
    "SELECT COALESCE(MAX(version), 0) AS v FROM webhook_definition WHERE ontology_id = $1 AND name = $2",
    [ontologyId, input.name],
  );
  const nextVersion = Number(maxVersionRes.rows[0].v) + 1;

  // endpoint_config defaults to { url, followRedirects: false } when the
  // caller passed nothing; DB-side CHECK only enforces object shape.
  const endpointConfig =
    input.endpointConfig ??
    ({
      url: "https://example.invalid",
      followRedirects: false,
    } as Record<string, unknown>);

  // authentication_config MUST be present (DB NOT NULL). The DB-CHECK
  // structural validation in route layer asserts it's a SecretReference-
  // shaped blob; here we only verify object shape.
  if (!input.authenticationConfig || typeof input.authenticationConfig !== "object") {
    throw appError("VALIDATION_FAILED", "authenticationConfig is required and must be a SecretReference object (never plaintext).");
  }
  if (!input.inputSchema || typeof input.inputSchema !== "object") {
    throw appError("VALIDATION_FAILED", "inputSchema is required (JSON Schema for the webhook request body).");
  }

  try {
    const result = await query(
      `INSERT INTO webhook_definition
         (ontology_id, name, version, description, status, method,
          endpoint_config, input_schema, output_schema, authentication_config,
          timeout_ms, max_response_bytes, retry_policy, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        ontologyId,
        input.name,
        nextVersion,
        input.description ?? null,
        status,
        input.method,
        JSON.stringify(endpointConfig),
        JSON.stringify(input.inputSchema),
        input.outputSchema ? JSON.stringify(input.outputSchema) : null,
        JSON.stringify(input.authenticationConfig),
        timeoutMs,
        maxResponseBytes,
        input.retryPolicy ? JSON.stringify(input.retryPolicy) : null,
        input.createdBy ?? "system",
      ],
    );
    return result.rows[0] as WebhookDefinitionRow;
  } catch (err: any) {
    if (err.code === "23505") {
      // The unique partial index fired concurrently.
      throw appError("WEBHOOK_ALREADY_EXISTS", `Webhook '${input.name}' already exists with status draft/active.`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Get the latest draft/active webhook version by (ontology_id, name).
 * Returns NULL when none exists. The BE runtime reads from here to
 * resolve the webhook binding referenced by an action type at execution
 * time (Phase 4 + 5).
 */
export async function getWebhookByName(
  ontologyId: string,
  name: string,
): Promise<WebhookDefinitionRow | null> {
  const result = await query(
    `SELECT * FROM webhook_definition
      WHERE ontology_id = $1 AND name = $2
        AND status IN ('draft', 'active')
      ORDER BY version DESC LIMIT 1`,
    [ontologyId, name],
  );
  return result.rows.length > 0 ? (result.rows[0] as WebhookDefinitionRow) : null;
}

/**
 * Get a specific immutable version of the webhook. Used when an action
 * type carries an explicit `(name, version)` reference — we MUST look
 * up the exact version (Phase 4 execution reads are immutable).
 */
export async function getWebhookByNameVersion(
  ontologyId: string,
  name: string,
  version: number,
): Promise<WebhookDefinitionRow | null> {
  const result = await query(
    "SELECT * FROM webhook_definition WHERE ontology_id = $1 AND name = $2 AND version = $3",
    [ontologyId, name, version],
  );
  return result.rows.length > 0 ? (result.rows[0] as WebhookDefinitionRow) : null;
}

export async function getWebhookById(
  webhookId: string,
): Promise<WebhookDefinitionRow | null> {
  const result = await query("SELECT * FROM webhook_definition WHERE webhook_id = $1", [webhookId]);
  return result.rows.length > 0 ? (result.rows[0] as WebhookDefinitionRow) : null;
}

export interface ListWebhooksFilters {
  status?: WebhookStatus;
}

export async function listWebhooks(
  ontologyId: string,
  filters?: ListWebhooksFilters,
): Promise<WebhookDefinitionRow[]> {
  if (filters?.status) {
    const result = await query(
      "SELECT * FROM webhook_definition WHERE ontology_id = $1 AND status = $2 ORDER BY name, version DESC",
      [ontologyId, filters.status],
    );
    return result.rows as WebhookDefinitionRow[];
  }
  const result = await query(
    `SELECT wd.*
       FROM webhook_definition wd
       JOIN (
         SELECT name, MAX(version) AS max_v
           FROM webhook_definition
          WHERE ontology_id = $1
          GROUP BY name
       ) latest ON latest.name = wd.name AND latest.max_v = wd.version
      WHERE wd.ontology_id = $1
      ORDER BY wd.name`,
    [ontologyId],
  );
  return result.rows as WebhookDefinitionRow[];
}

// ---------------------------------------------------------------------------
// Update — bumps version (new row) by default; structural in-place
// updates reserved for internal use (e.g. lifecycle flip)
// ---------------------------------------------------------------------------

/**
 * Update a webhook definition by bumping its version. A NEW row with
 * `(ontology_id, name, current_version + 1)` is INSERTed with the
 * updated fields; the previous row stays immutable so existing
 * action_type → webhook bindings keep their persisted meaning.
 */
export async function bumpWebhookVersion(
  ontologyId: string,
  name: string,
  updates: UpdateWebhookDefinitionInput,
): Promise<WebhookDefinitionRow> {
  const current = await getWebhookByName(ontologyId, name);
  if (!current) {
    throw appError("WEBHOOK_NOT_FOUND", `Webhook '${name}' not found (no draft/active version exists in this ontology).`);
  }
  if (current.status === "disabled") {
    throw appError("WEBHOOK_VERSION_DISABLED", `Webhook '${name}' is disabled; cannot bump version.`);
  }

  // If the only mutation is a status change to 'disabled', the spec
  // (lifecycle) keeps the version (a status flip to 'disabled' is a
  // lifecycle mark, not a config bump that needs immutability for
  // callers — the existing version reference stays valid). In that
  // case, do an in-place UPDATE of just the status. Otherwise bump.
  const statusOnlyDisable =
    updates.status === "disabled" &&
    Object.keys(updates).filter((k) => updates[k as keyof UpdateWebhookDefinitionInput] !== undefined && k !== "bumpVersion" && k !== "updatedBy").length === 1;

  if (statusOnlyDisable) {
    const result = await query(
      `UPDATE webhook_definition
          SET status = 'disabled', updated_at = now()
        WHERE ontology_id = $1 AND name = $2 AND version = $3
        RETURNING *`,
      [ontologyId, name, current.version],
    );
    return result.rows[0] as WebhookDefinitionRow;
  }

  const nextVersion = current.version + 1;
  const next: Required<Omit<UpdateWebhookDefinitionInput, "bumpVersion" | "updatedBy">> = {
    displayName: updates.displayName ?? "",
    description: updates.description ?? current.description,
    status: updates.status ?? current.status,
    method: updates.method ?? current.method,
    endpointConfig: updates.endpointConfig ?? current.endpoint_config,
    inputSchema: updates.inputSchema ?? current.input_schema,
    // Response schema bumps per Phase 4 — preserve current unless caller
    // supplies a new one.
    outputSchema: updates.outputSchema !== undefined ? updates.outputSchema : (current.output_schema ?? null),
    authenticationConfig: updates.authenticationConfig ?? current.authentication_config,
    timeoutMs: updates.timeoutMs ?? current.timeout_ms,
    maxResponseBytes: updates.maxResponseBytes ?? current.max_response_bytes,
    retryPolicy: updates.retryPolicy !== undefined ? updates.retryPolicy : (current.retry_policy ?? null),
  };

  // Mark the current row as 'disabled' so the partial unique index
  // releases the (ontology_id, name) "slot" for the new active row. We
  // do this in a single transaction so a crash mid-bump doesn't leave
  // the registry in a half-state where two rows compete for the slot.
  try {
    return await withTransaction(async (client: PoolClient) => {
      await client.query(
        `UPDATE webhook_definition
            SET status = 'disabled', updated_at = now()
          WHERE ontology_id = $1 AND name = $2 AND version = $3`,
        [ontologyId, name, current.version],
      );
      const result = await client.query(
        `INSERT INTO webhook_definition
           (ontology_id, name, version, description, status, method,
            endpoint_config, input_schema, output_schema, authentication_config,
            timeout_ms, max_response_bytes, retry_policy, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          ontologyId,
          name,
          nextVersion,
          next.description !== current.description ? next.description : current.description,
          next.status,
          next.method,
          JSON.stringify(next.endpointConfig),
          JSON.stringify(next.inputSchema),
          next.outputSchema ? JSON.stringify(next.outputSchema) : null,
          JSON.stringify(next.authenticationConfig),
          next.timeoutMs,
          next.maxResponseBytes,
          next.retryPolicy ? JSON.stringify(next.retryPolicy) : null,
          updates.updatedBy ?? "system",
        ],
      );
      return result.rows[0] as WebhookDefinitionRow;
    });
  } catch (err: any) {
    if (err.code === "23505") {
      throw appError("WEBHOOK_ALREADY_EXISTS", `Webhook '${name}' already has a draft/active version (concurrent bump).`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Delete — admin-only at the route layer; here we provide a soft-delete
// path (status='disabled') and a hard-delete fallback for tests
// ---------------------------------------------------------------------------

export async function disableWebhook(
  ontologyId: string,
  name: string,
): Promise<WebhookDefinitionRow | null> {
  const current = await getWebhookByName(ontologyId, name);
  if (!current) return null;
  const result = await query(
    `UPDATE webhook_definition
        SET status = 'disabled', updated_at = now()
      WHERE ontology_id = $1 AND name = $2 AND version = $3
      RETURNING *`,
    [ontologyId, name, current.version],
  );
  return result.rows.length > 0 ? (result.rows[0] as WebhookDefinitionRow) : null;
}

export async function hardDeleteWebhook(
  ontologyId: string,
  name: string,
): Promise<boolean> {
  const r = await query(
    "DELETE FROM webhook_definition WHERE ontology_id = $1 AND name = $2",
    [ontologyId, name],
  );
  return (r.rowCount ?? 0) > 0;
}
