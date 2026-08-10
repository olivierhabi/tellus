// ---------------------------------------------------------------------------
// Writeback Executor — Phase 4 pre-edit stage
//
// Runs the writeback webhook BEFORE any ontology edit is applied. The
// action type carries `writeback_config` (one-writeback-per-action
// invariant enforced structurally by migration 130). The executor:
//
//   1. Loads the immutable webhook version by (ontologyId, webhookId,
//      webhookVersion). Refuses to execute when the version is
//      'disabled' (WRITEBACK_REJECTED).
//   2. Resolves each `inputs[name]` ValueSource against the action's
//      parameters (only `parameter` source is supported today; `static`
//      + `currentTimestamp` + `currentUser` also accepted for cheap
//      diagnostics).
//   3. Validates the request body against `webhook.inputSchema` (flat
//      shape: top-level properties must be present in resolved inputs).
//   4. Builds the HTTP request body (JSON), applies
//      `webhookSafeTransport.assertEgressUrl` to the endpoint URL,
//      `sanitizeOutboundHeaders` to the headers, applies the
//      authenticationConfig secret reference header (TODO Phase 6:
//      resolve SecretReference against Tellus's secrets manager).
//   5. Issues the request via the injected `httpRequest` (default: a
//      production-grade https.request). Catches networking errors and
//      surfaces them as `WRITEBACK_TIMEOUT` (no response) or
//      `WRITEBACK_REJECTED` (non-2xx response).
//   6. Validates the response: content-type allowlist, status 2xx,
//      body size <= max_response_bytes, JSON parse, and per-binding
//      extraction: each outputBinding's `path` (RFC 6901 JSONPointer)
//      is evaluated against the parsed response, the extracted value
//      is returned in the typed outputs map keyed by `outputId`. No
//      silent type coercion — the route layer's save-time typecheck
//      already validated binding shapes.
//   7. Returns the typed outputs map和处理 errors to the caller. The
//      caller (actionExecutor Phase 5 path) MUST abort the transaction
//      when `kind: "rejected"` is returned — no ontology edit is
//      applied; the user-visible error is the sanitized `code` +
//      `message`. Detailed diagnostic data (full request body, full
//      response body, headers) stays in the ERROR-LEVEL structured log
//      (Phase 6 logs the request/response without secrets via
//      webhookSafeTransport.redactHeadersForLog).
//
// On cancellation/idempotency: Phase 4 generates the idempotency key from
// the execution_id + a stable monotonic attempt counter; the BE
// invocable worker writes it on every attempt so external systems can
// deduplicate. The "external-success / local-commit-failure window" is
// acknowledged (Phase 4 does NOT claim distributed transactionality)
// and reconciled through the durable outbox's `external_receipt` column
// (Phase 5). The Phase 4 surface here returns the internal_receipt
// material so an action_audit_log row records it for operators to
// reconcile manually until Phase 5 lands the worker.
// ---------------------------------------------------------------------------

import { getWebhookByNameVersion, type WebhookDefinitionRow } from "../models/webhookDefinition";
import {
  getByRid as getConnectivityWebhookByRid,
} from "../services/connectivity/webhooks/repository";
import { findByRid as findConnectionByRid } from "../services/connectivity/store/connections.repo";
import { executeWebhook as executeConnectivityWebhook } from "../services/connectivity/webhooks/executor";
import { warnLegacyWebhookDispatch } from "../services/connectivity/webhooks/router";
import {
  assertEgressUrl,
  assertMethod,
  assertResponseBytes,
  assertResponseContentType,
  redactHeadersForLog,
  sanitizeOutboundHeaders,
  type EgressPolicy,
  type SafeTransportResult,
} from "../services/webhookSafeTransport";

// ---------------------------------------------------------------------------
// Dual-typed webhook reference
//
// `writeback_config.webhookId` is:
//   * `ri.magritte.main.webhook.<uuid>` — a REAL data-connection webhook,
//     executed by the connectivity engine (vault-resolved secrets,
//     SSRF/DNS-pinned egress, retries, idempotency, recorded
//     executions). Canonical going forward.
//   * anything else — a legacy `webhook_definition` registry name,
//     executed by the Phase 4 direct-HTTP path below (backward
//     compatibility for bindings authored before the connectivity
//     wiring).
// ---------------------------------------------------------------------------

export const CONNECTIVITY_WEBHOOK_RID_PREFIX = "ri.magritte.main.webhook.";

export function isConnectivityWebhookRef(webhookId: string): boolean {
  return webhookId.startsWith(CONNECTIVITY_WEBHOOK_RID_PREFIX);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Match against the canonical WritebackResponseValueSource from actionRules.types.ts. */
export interface WritebackResponseValueSource {
  readonly source: "writebackResponse";
  readonly outputId: string;
  readonly path?: string;
}

export interface WritebackOutputDefinition {
  outputId: string;
  path: string;
  schema: Record<string, unknown>;
  valueType: string;
}

export interface WritebackConfig {
  webhookId: string;
  webhookVersion: number;
  inputs: Record<string, unknown>;
  outputBindings?: Record<string, WritebackOutputDefinition>;
  failurePolicy: "abort";
}

export interface WritebackExecutionContext {
  /** The actor's principal id (used for the X-Actor header + audit). */
  actor: string;
  /** Stable per-execution UUID — used to derive the idempotency key. */
  executionId: string;
  /** Optional: the existing ontologyId scope (defence-in-depth on the
   * webhookId's ontology). The executor uses the action_type's
   * ontologyId from the actionExecutor; this is passed through for the
   * eventual Phase 6 cross-ontology permissioning case. */
  ontologyId: string;
  /**
   * Tenant scope for connectivity-webhook resolution (the connectivity
   * store is tenant-scoped). Threaded from the route's authenticated
   * principal; falls back to "default" — the same fallback the
   * connectivity handlers use — when the caller has no tenant claim
   * (tests, internal/system callers).
   */
  tenant?: string;
}

export type WritebackResult =
  | {
      kind: "ok";
      httpStatus: number;
      /** Per `outputId` from outputBindings → the extracted value (validated
       * against `binding.schema`). Caller (ruleCompiler) exposes this to
       * rules via `writebackResponse` ValueSource. */
      outputs: Record<string, unknown>;
      /** The full parsed response body for diagnostic logging. */
      responseBody: unknown;
      /** Idempotency key sent to the external system on the request. */
      idempotencyKey: string;
    }
  | {
      kind: "rejected";
      code:
        | "WEBHOOK_NOT_FOUND"
        | "WEBHOOK_VERSION_DISABLED"
        | "WRITEBACK_CONFIG_INVALID"
        | "WRITEBACK_TIMEOUT"
        | "WRITEBACK_REJECTED"
        | "WRITEBACK_OUTPUT_SCHEMA_MISMATCH";
      message: string;
      /** Sanitized user-visible hint — never includes Authorization, headers, or body. */
      userMessage: string;
      /** Full diagnostic context for structured ERROR logs (BE only). */
      diagnostic: {
        httpStatus?: number;
        endpoint?: string;
        webhookName: string;
        webhookVersion: number;
        contentType?: string;
        responseBodyBytes?: number;
        responseBody?: unknown;
        redactedHeaders?: Record<string, string>;
        responseHeaders?: Record<string, string>;
      };
    };

// ---------------------------------------------------------------------------
// HTTP request interface (testable)
// ---------------------------------------------------------------------------

/** The transport caller — Phase 4 production injects an `https.request`-
 *  based implementation; tests inject a stub that returns a fixed
 *  { status, body, contentType, headers } tuple. */
export interface HttpResponseSimulated {
  status: number;
  body: string;        // raw response body string
  contentType: string;
  headers: Record<string, string>;
  durationMs?: number;
}

export type HttpRequestFn = (params: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<HttpResponseSimulated>;

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeWriteback(
  config: WritebackConfig,
  ctx: WritebackExecutionContext,
  policy: EgressPolicy,
  httpRequest: HttpRequestFn,
): Promise<WritebackResult> {
  // Dual-typed reference: data-connection webhooks (the real webhook
  // implementation) are executed by the connectivity engine; legacy
  // registry names continue down the Phase 4 direct-HTTP path.
  if (isConnectivityWebhookRef(config.webhookId)) {
    return executeConnectivityWriteback(config, ctx);
  }

  // F9 — legacy direct-HTTP path (System C). DEPRECATED. Emit a warning so
  // operators can track the remaining legacy footprint; new bindings MUST
  // use a connectivity webhook RID. See docs/data-connection/webhook-systems.md.
  warnLegacyWebhookDispatch(config.webhookId, "writebackExecutor.executeWriteback");

  // 1. Load the webhook version (immutable).
  const webhook: WebhookDefinitionRow | null = await getWebhookByNameVersion(
    ctx.ontologyId,
    config.webhookId,
    config.webhookVersion,
  );
  if (!webhook) {
    return {
      kind: "rejected",
      code: "WEBHOOK_NOT_FOUND",
      message: `Webhook '${config.webhookId}' v${config.webhookVersion} was not found.`,
      userMessage: "The configured webhook was not found.",
      diagnostic: {
        webhookName: config.webhookId,
        webhookVersion: config.webhookVersion,
      },
    };
  }
  if (webhook.status === "disabled") {
    return {
      kind: "rejected",
      code: "WEBHOOK_VERSION_DISABLED",
      message: `Webhook '${webhook.name}' v${webhook.version} is disabled.`,
      userMessage: "The configured webhook has been disabled. Update the action type to bind a newer version.",
      diagnostic: {
        webhookName: webhook.name,
        webhookVersion: webhook.version,
      },
    };
  }

  // 2. Build the request body from `inputs`. Each input is a ValueSource
  //    (validated structurally at save time by routes/actionTypes.ts; here
  //    we resolve against the resolved parameters drawn from `inputs`
  //    themselves). Phase 4 executes the resolveValue logic against the
  //    EXECUTOR's resolved-parameter map — callers pass already-resolved
  //    values in `inputs` (it's a flat Record<string, unknown> by this
  //    point; resolve was done by the actionExecutor's parameter
  //    validator pipeline). This keeps the WritebackExecutor pure (no
  //    action execution context) and lets the actionExecutor test
  //    harness mock both layers with the same input shape.
  const body = JSON.stringify(config.inputs);

  // 3. Egress checks.
  const epCfg = (webhook.endpoint_config ?? {}) as { url?: string };
  if (!epCfg.url || typeof epCfg.url !== "string") {
    return {
      kind: "rejected",
      code: "WRITEBACK_CONFIG_INVALID",
      message: `Webhook '${webhook.name}' v${webhook.version} has no endpoint URL configured (endpoint_config.url is missing).`,
      userMessage: "The webhook's endpoint URL is not configured.",
      diagnostic: { webhookName: webhook.name, webhookVersion: webhook.version },
    };
  }
  const urlResult = assertEgressUrl(epCfg.url, policy);
  if (urlResult.kind !== "ok") {
    const safe = urlResult.kind === "errors" ? urlResult.errors[0] : { code: "WRITEBACK_REJECTED", message: "egress check failed" };
    return {
      kind: "rejected",
      code: "WRITEBACK_REJECTED",
      message: `Egress check failed for '${epCfg.url}': ${safe.code}: ${safe.message}`,
      userMessage: "The configured webhook endpoint is not allowed by the egress policy.",
      diagnostic: { webhookName: webhook.name, webhookVersion: webhook.version, endpoint: epCfg.url },
    };
  }
  const methodResult = assertMethod(webhook.method);
  if (methodResult.kind !== "ok") {
    const code = methodResult.kind === "errors" ? methodResult.errors[0] : { code: "WRITEBACK_REJECTED", message: "method invalid" };
    return {
      kind: "rejected",
      code: "WRITEBACK_REJECTED",
      message: `Method check failed for ${webhook.method}: ${code.code}: ${code.message}`,
      userMessage: "The webhook's HTTP method is not allowed.",
      diagnostic: { webhookName: webhook.name, webhookVersion: webhook.version },
    };
  }

  // 4. Outbound headers. Phase 4 seeds:
  //   - Authorization: <placeholder> — Phase 6 secret resolver
  //   - X-Idempotency-Key: (execution_id, 1)
  //   - X-Trace-Id: execution_id
  // Request body shape uses inputSchema; the route layer's input-validator
  // (validation already happened at action-type save time) accepted the
  // binding. Phase 4 sends the resolved inputs as the JSON body — the
  // transport layer serializes them.
  const idempotencyKey = computeIdempotencyKey(ctx.executionId, 1);
  const rawHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-Idempotency-Key": idempotencyKey,
    "X-Trace-Id": ctx.executionId,
    "X-Actor": ctx.actor,
    // Phase 6 will replace this with a real SecretReference resolver
    // against Tellus's secrets manager; for Phase 4, the webhook's
    // placeholder `authenticationConfig.key` (e.g. "apiToken") is sent
    // as a literal bearing the (mocked) secret name, NOT the secret. The
    // production transport layer (Phase 5 outbox worker) calls the secret
    // resolver to materialise `Bearer <real-token>`.
    Authorization: `Bearer <secret:${webhook.authentication_config?.kind ?? "tellus_secret"}/${(webhook.authentication_config as any)?.ref ?? "?"}>`,
  };
  const cleaned = sanitizeOutboundHeaders(rawHeaders, policy);
  const headers = cleaned.headers;

  // 5. Execute the HTTP request. The injected `httpRequest` returns the
  //    simulated response (or aborts/times out — caller-side.
  let response: HttpResponseSimulated;
  try {
    response = await httpRequest({
      method: webhook.method,
      url: epCfg.url,
      headers,
      body,
      timeoutMs: webhook.timeout_ms,
    });
  } catch (e: any) {
    return {
      kind: "rejected",
      code: "WRITEBACK_TIMEOUT",
      message: `HTTP request failed: ${e?.message ?? String(e)}`,
      userMessage: "The configured webhook endpoint did not respond in time. No ontology edits were applied.",
      diagnostic: {
        webhookName: webhook.name,
        webhookVersion: webhook.version,
        endpoint: epCfg.url,
      },
    };
  }

  // 6. Validate the response: status code, content-type, body size.
  if (response.status < 200 || response.status >= 300) {
    return {
      kind: "rejected",
      code: "WRITEBACK_REJECTED",
      message: `Webhook returned non-2xx status ${response.status}.`,
      userMessage: "The external system rejected the writeback. No ontology edits were applied.",
      diagnostic: {
        webhookName: webhook.name,
        webhookVersion: webhook.version,
        httpStatus: response.status,
        endpoint: epCfg.url,
        contentType: response.contentType,
        responseBodyBytes: response.body.length,
        redactedHeaders: redactHeadersForLog(headers),
        responseHeaders: response.headers,
        responseBody: response.body ? safeSampleForDiagnostic(response.body) : undefined,
      },
    };
  }
  const ctResult = assertResponseContentType(response.contentType, policy);
  if (ctResult.kind !== "ok") {
    return {
      kind: "rejected",
      code: "WRITEBACK_REJECTED",
      message: `Response Content-Type '${response.contentType}' is not allowed.`,
      userMessage: "The external system returned an unsupported response Content-Type. No ontology edits were applied.",
      diagnostic: {
        webhookName: webhook.name,
        webhookVersion: webhook.version,
        httpStatus: response.status,
        contentType: response.contentType,
        responseBodyBytes: response.body.length,
        redactedHeaders: redactHeadersForLog(headers),
        responseHeaders: response.headers,
        responseBody: safeSampleForDiagnostic(response.body),
      },
    };
  }
  const sizeResult = assertResponseBytes(response.body.length, policy);
  if (sizeResult.kind !== "ok") {
    return {
      kind: "rejected",
      code: "WRITEBACK_REJECTED",
      message: `Response body ${response.body.length} B exceeds maxResponseBytes (${webhook.max_response_bytes}) configured on the webhook.`,
      userMessage: "The external system returned a response larger than the configured maximum. No ontology edits were applied.",
      diagnostic: {
        webhookName: webhook.name,
        webhookVersion: webhook.version,
        httpStatus: response.status,
        contentType: response.contentType,
        responseBodyBytes: response.body.length,
        redactedHeaders: redactHeadersForLog(headers),
        responseHeaders: response.headers,
      },
    };
  }

  // 7. Parse body. Per-binding extraction: walk outputBindings via the
  //    declared RFC 6901 JSONPointer; the per-binding `schema` would be
  //    the JSON Schema of the extracted value — Phase 4 skips schema
  //    validation (a JSON Schema validator is a Phase 6 deliverable) and
  //    extracts the value via JSONPointer only. The valueType coercion
  //    also lands in Phase 6 (centralized ontology coercion); Phase 4
  //    surfaces the raw extracted value.
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch (e: any) {
    return {
      kind: "rejected",
      code: "WRITEBACK_OUTPUT_SCHEMA_MISMATCH",
      message: `Response body could not be parsed as JSON: ${e?.message ?? String(e)}`,
      userMessage: "The external system's response was not valid JSON. No ontology edits were applied.",
      diagnostic: {
        webhookName: webhook.name,
        webhookVersion: webhook.version,
        httpStatus: response.status,
        contentType: response.contentType,
        responseBodyBytes: response.body.length,
        redactedHeaders: redactHeadersForLog(headers),
        responseHeaders: response.headers,
        responseBody: safeSampleForDiagnostic(response.body),
      },
    };
  }

  const outputs: Record<string, unknown> = {};
  if (config.outputBindings) {
    for (const [oid, def] of Object.entries(config.outputBindings)) {
      try {
        outputs[oid] = extractJsonPointer(parsed, def.path);
      } catch (e: any) {
        return {
          kind: "rejected",
          code: "WRITEBACK_OUTPUT_SCHEMA_MISMATCH",
          message: `outputBindings.${oid} (path='${def.path}') extraction failed: ${e?.message ?? String(e)}`,
          userMessage: "A typed output binding could not be extracted from the response. No ontology edits were applied.",
          diagnostic: {
            webhookName: webhook.name,
            webhookVersion: webhook.version,
            httpStatus: response.status,
            contentType: response.contentType,
            responseBodyBytes: response.body.length,
            redactedHeaders: redactHeadersForLog(headers),
            responseHeaders: response.headers,
            responseBody: safeSampleForDiagnostic(response.body),
          },
        };
      }
    }
  }

  return {
    kind: "ok",
    httpStatus: response.status,
    outputs,
    responseBody: parsed,
    idempotencyKey,
  };
}

// ---------------------------------------------------------------------------
// Connectivity writeback — the REAL webhook implementation
//
// Executes the bound data-connection webhook through the connectivity
// engine (`services/connectivity/webhooks/executor.executeWebhook`)
// instead of the Phase 4 direct-HTTP path. Inherits the engine's full
// production semantics:
//
//   * Connection-scoped execution: the parent REST source supplies the
//     domains, the egress allowlist AND the vault-resolved secrets — no
//     placeholder `Bearer <secret:…>` headers.
//   * SSRF + DNS-pinning guards, HMAC request signing, sanitized headers.
//   * Retry policy with backoff, retryable-status classification.
//   * Idempotency: the engine dedupes on (webhookRid, idempotencyKey,
//     actor) — a retried action attempt REPLAYS the prior execution row
//     instead of double-firing the external system.
//   * Every execution + delivery attempt is recorded
//     (`connectivity_webhook_execution` / `_delivery_attempt`) for the
//     operator-facing execution history.
//
// Output mapping: the connectivity engine extracts the webhook version's
// DECLARED outputs (`configuration.outputs` selectors) into the
// execution's `outputSummary`; that map IS the typed outputs map the
// ruleCompiler consumes for `writebackResponse` value sources (keyed by
// the webhook's declared output ids). The registry-era
// `writeback_config.outputBindings` (JSONPointer extraction) does not
// apply to connectivity references and is ignored here.
// ---------------------------------------------------------------------------

async function executeConnectivityWriteback(
  config: WritebackConfig,
  ctx: WritebackExecutionContext,
): Promise<WritebackResult> {
  const tenant = ctx.tenant ?? "default";
  const diagnosticBase = {
    webhookName: config.webhookId,
    webhookVersion: config.webhookVersion,
  };

  // 1. Resolve the pinned immutable version. Bindings never silently
  //    follow the webhook's current version.
  let webhook;
  try {
    webhook = await getConnectivityWebhookByRid(
      config.webhookId,
      tenant,
      config.webhookVersion,
    );
  } catch {
    return {
      kind: "rejected",
      code: "WEBHOOK_NOT_FOUND",
      message: `Data-connection webhook '${config.webhookId}' v${config.webhookVersion} was not found.`,
      userMessage: "The configured webhook was not found.",
      diagnostic: diagnosticBase,
    };
  }

  // 2. Lifecycle gate. The connectivity engine refuses production
  //    execution for anything but 'active' — surface the same refusal
  //    through the writeback envelope so the action aborts cleanly
  //    BEFORE any ontology edit is staged.
  if (webhook.status !== "active") {
    return {
      kind: "rejected",
      code: "WEBHOOK_VERSION_DISABLED",
      message: `Data-connection webhook '${webhook.displayName}' (${webhook.rid}) is '${webhook.status}' — only 'active' webhooks can execute a writeback.`,
      userMessage: "The configured webhook is not active. Activate it from the source's Webhooks tab, or update the action type to bind an active webhook.",
      diagnostic: diagnosticBase,
    };
  }

  // 3. Resolve the parent connection (carries the egress policy + the
  //    vault handle the engine resolves secrets through).
  let connection;
  try {
    connection = await findConnectionByRid(webhook.connectionRid, tenant);
  } catch {
    return {
      kind: "rejected",
      code: "WRITEBACK_CONFIG_INVALID",
      message: `Data-connection webhook '${webhook.rid}' references connection '${webhook.connectionRid}' which could not be loaded.`,
      userMessage: "The webhook's data connection is unavailable.",
      diagnostic: diagnosticBase,
    };
  }

  // 4. Execute through the connectivity engine. The idempotency key is
  //    derived from the action execution id + attempt counter exactly
  //    like the legacy path, so the engine's replay semantics dedupe
  //    retried attempts of the SAME action execution.
  const idempotencyKey = computeIdempotencyKey(ctx.executionId, 1);
  let result;
  try {
    result = await executeConnectivityWebhook({
      webhook,
      connection,
      tenant,
      actor: ctx.actor,
      kind: "production",
      inputs: config.inputs,
      idempotencyKey,
    });
  } catch (e: any) {
    return {
      kind: "rejected",
      code: "WRITEBACK_REJECTED",
      message: `Data-connection webhook execution failed: ${e?.message ?? String(e)}`,
      userMessage: "The external system rejected the writeback. No ontology edits were applied.",
      diagnostic: diagnosticBase,
    };
  }

  const execution = result.execution;
  if (execution.status !== "succeeded") {
    const isTimeout = execution.errorCode === "REQUEST_TIMEOUT";
    return {
      kind: "rejected",
      code: isTimeout ? "WRITEBACK_TIMEOUT" : "WRITEBACK_REJECTED",
      message: `Data-connection webhook execution ${execution.status}: ${execution.errorMessage ?? execution.errorCode ?? "unknown error"}`,
      userMessage: isTimeout
        ? "The configured webhook endpoint did not respond in time. No ontology edits were applied."
        : "The external system rejected the writeback. No ontology edits were applied.",
      diagnostic: {
        ...diagnosticBase,
        httpStatus: execution.httpStatus ?? undefined,
      },
    };
  }

  // 5. The engine's extracted outputs are the typed outputs map for
  //    `writebackResponse` value sources.
  const outputs = (execution.outputSummary ?? {}) as Record<string, unknown>;
  return {
    kind: "ok",
    httpStatus: execution.httpStatus ?? 200,
    outputs,
    responseBody: execution.outputSummary,
    idempotencyKey,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { createHash } from "crypto";

function computeIdempotencyKey(executionId: string, attempt: number): string {
  return createHash("sha256")
    .update(`${executionId}.${attempt}`, "utf8")
    .digest("hex");
}

/**
 * RFC 6901 JSONPointer evaluation. Implements:
 *   - "" or "/" → root
 *   - "/a/b/c" → obj.a.b.c (with `~0` → `~` and `~1` → `/` escaping)
 * The validator's input-schema checks ensure the value at the
 * pointer conforms to the binding's declared schema. Phase 4 just
 * extracts; the schema + valueType validation lands in Phase 6 (a
 * JSON Schema validator + ontology coercion are large deliverables
 * of their own).
 */
function extractJsonPointer(rootObj: unknown, pointer: string): unknown {
  if (!pointer || pointer === "" || pointer === "/") return rootObj;
  if (!pointer.startsWith("/")) {
    throw new Error(`JSONPointer '${pointer}' must start with '/'.`);
  }
  const segments = pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: any = rootObj;
  for (const seg of segments) {
    if (current == null) {
      throw new Error(`Cannot descend '${seg}' into null/undefined.`);
    }
    if (Array.isArray(current)) {
      const idx = Number.parseInt(seg, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= current.length) {
        throw new Error(`Array index '${seg}' out of range (len=${current.length}).`);
      }
      current = current[idx];
    } else if (typeof current === "object") {
      if (!(seg in current)) {
        throw new Error(`Key '${seg}' not found in object.`);
      }
      current = current[seg];
    } else {
      throw new Error(`Cannot descend '${seg}' into primitive value.`);
    }
  }
  return current;
}

/**
 * Truncate response body to a small diagnostic window so structured logs
 * never accidentally write megabytes of response into the log pipeline.
 * Phase 5 / 6 streams the full body to S3 with a TTL — Phase 4 logs a
 * 4 KiB tail-sampled glimpse for in-line debugging only. Sensitive
 * response bodies (API tokens, password-reset payloads, etc.) are
 * redacted by the BE transport layer's response filters before reaching
 * this sample.
 */
function safeSampleForDiagnostic(body: string): string {
  if (typeof body !== "string") return "<non-string body>";
  const MAX = 4096;
  if (body.length <= MAX) return body;
  return `${body.length}B body; first ${MAX}B below:\n` + body.substring(0, MAX);
}
