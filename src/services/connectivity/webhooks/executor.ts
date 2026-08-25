import { createHash, createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Connection } from "../contracts";
import * as vault from "../credentials/vault";
import {
  assertMethod,
  assertEgressUrl,
  assertRequestBytes,
  assertResponseBytes,
  assertResponseContentType,
  redactHeadersForLog,
  sanitizeOutboundHeaders,
  type EgressPolicy as SafeEgressPolicy,
} from "../../webhookSafeTransport";
import type {
  ConnectivityWebhook,
  OutputParameter,
  RequestBody,
  RequestValue,
  WebhookCall,
  WebhookExecutionSummary,
  WebhookParameterTypeValue,
} from "./contracts";
import * as repository from "./repository";
import { recordEgressAudit } from "../health/egressAudit.repo";
import { assertAgentAvailable, resolveAgentForGroup } from "../agent/proxy";

// ---------------------------------------------------------------------------
// F7 — Agent network modeling (P1).
//
// IMPORTANT: webhook execution performs DIRECT BACKEND EGRESS. The HTTP
// request is opened from the backend Node process via node:http/https
// (see `requestPinnedDestination` below). The connection's `agentGroupRid`,
// when `workerType === "agentProxy"`, is consulted ONLY as a liveness gate
// (assertAgentAvailable) by the PG pool — it does NOT tunnel webhook egress.
//
// The connection's `settings.egressMode` records the operator's
// acknowledgement of this model:
//   - "direct" (default): egress originates from the backend directly. The
//     audit log entry below records every such direct egress so operators can
//     inspect who triggered it and to where.
//   - "agent-tunnel": reserved for a future transport that routes the request
//     through the agent. Until that transport ships, this code still performs
//     a direct egress and emits a warning to the audit log.
// ---------------------------------------------------------------------------

const TEMPLATE_TOKEN =
  /\{\{\s*(inputs\.[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*|calls\.[0-9a-f-]{36}(?:\.[A-Za-z0-9_]+)*)\s*\}\}/gi;
const FORBIDDEN_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "transfer-encoding",
  "upgrade",
]);
const SENSITIVE_QUERY_KEY = /(token|secret|password|key|credential|signature)/i;
const SENSITIVE_INPUT_KEY =
  /(authorization|auth|token|secret|password|passwd|api[_-]?key|credential|cookie|signature)/i;

export interface ExecuteWebhookOptions {
  webhook: ConnectivityWebhook;
  connection: Connection;
  tenant: string;
  actor: string;
  kind: "test" | "production";
  inputs: Record<string, unknown>;
  idempotencyKey?: string;
  /** Correlation supplied by the action/request that caused this execution. */
  correlationId?: string;
  requestId?: string;
  clientIp?: string;
}

export interface ExecuteWebhookResult {
  execution: WebhookExecutionSummary;
  replayed: boolean;
}

interface ResolvedDestination {
  address: string;
  family: 4 | 6;
}

interface CallRuntimeResult {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: unknown;
}

interface RuntimeContext {
  inputs: Record<string, unknown>;
  calls: Record<string, CallRuntimeResult>;
}

function redactKnownSecrets(value: unknown, secrets: Record<string, string>): unknown {
  if (typeof value === "string") {
    let safe = value;
    for (const secret of Object.values(secrets)) {
      if (secret.length >= 4) safe = safe.split(secret).join("[REDACTED]");
    }
    return safe.length > 16_384 ? `${safe.slice(0, 16_384)}…[TRUNCATED]` : safe;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redactKnownSecrets(entry, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, entry]) => [
          key,
          SENSITIVE_INPUT_KEY.test(key)
            ? "[REDACTED]"
            : redactKnownSecrets(entry, secrets),
        ]),
    );
  }
  return value;
}

export function redactExecutionInputs(
  webhook: ConnectivityWebhook,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    webhook.configuration.inputs.map((input) => [
      input.id,
      SENSITIVE_INPUT_KEY.test(input.id)
        ? "[REDACTED]"
        : input.type.kind === "attachment" && inputs[input.id] !== undefined
          ? "[ATTACHMENT]"
          : redactKnownSecrets(inputs[input.id] ?? null, {}),
    ]),
  );
}

class WebhookExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly httpStatus?: number,
    readonly externalSystemChanged?: boolean,
  ) {
    super(message);
  }
}

function readPath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const part of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function resolveToken(token: string, ctx: RuntimeContext): unknown {
  const parts = token.split(".");
  if (parts[0] === "inputs") return readPath(ctx.inputs, parts.slice(1));
  if (parts[0] === "calls") {
    const call = ctx.calls[parts[1]];
    if (!call) {
      throw new WebhookExecutionError(
        "TEMPLATE_REFERENCE_UNAVAILABLE",
        `Call output '${parts[1]}' is not available yet.`,
      );
    }
    if (parts[2] === "status") return call.status;
    if (parts[2] === "body") return readPath(call.bodyJson, parts.slice(3));
    if (parts[2] === "headers") {
      return readPath(call.headers, parts.slice(3).map((part) => part.toLowerCase()));
    }
  }
  throw new WebhookExecutionError(
    "TEMPLATE_REFERENCE_INVALID",
    `Template reference '${token}' is not supported.`,
  );
}

export function renderTextTemplate(template: string, ctx: RuntimeContext): string {
  const unknownTokens = template.match(/\{\{[\s\S]*?\}\}/g) ?? [];
  for (const raw of unknownTokens) {
    const probe = new RegExp(`^${TEMPLATE_TOKEN.source}$`, "i");
    if (!probe.test(raw)) {
      throw new WebhookExecutionError(
        "TEMPLATE_SYNTAX_INVALID",
        "Templates may only reference typed webhook inputs or earlier call outputs.",
      );
    }
  }
  return template.replace(TEMPLATE_TOKEN, (_match, token: string) => {
    const value = resolveToken(token, ctx);
    if (value === undefined) {
      throw new WebhookExecutionError(
        "TEMPLATE_VALUE_MISSING",
        `No value was provided for '${token}'.`,
      );
    }
    if (value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

export function renderJsonTemplate(template: string, ctx: RuntimeContext): string {
  const rendered = template.replace(TEMPLATE_TOKEN, (_match, token: string) => {
    const value = resolveToken(token, ctx);
    if (value === undefined) {
      throw new WebhookExecutionError(
        "TEMPLATE_VALUE_MISSING",
        `No value was provided for '${token}'.`,
      );
    }
    return JSON.stringify(value);
  });
  const unknown = rendered.match(/\{\{[\s\S]*?\}\}/);
  if (unknown) {
    throw new WebhookExecutionError(
      "TEMPLATE_SYNTAX_INVALID",
      "JSON templates may only contain simple input or earlier-call references.",
    );
  }
  try {
    JSON.parse(rendered);
  } catch {
    throw new WebhookExecutionError(
      "TEMPLATE_JSON_INVALID",
      "The rendered request body is not valid JSON.",
    );
  }
  return rendered;
}

function resolveRequestValue(
  value: RequestValue,
  ctx: RuntimeContext,
  secrets: Record<string, string>,
): string {
  if (value.kind === "literal") return value.value;
  if (value.kind === "template") return renderTextTemplate(value.template, ctx);
  const secret = secrets[value.secretName];
  if (secret === undefined) {
    throw new WebhookExecutionError(
      "SECRET_NOT_FOUND",
      `The source secret reference '${value.secretName}' is unavailable.`,
    );
  }
  return `${value.prefix}${secret}`;
}

function validateInputType(value: unknown, type: WebhookParameterTypeValue): boolean {
  switch (type.kind) {
    case "attachment":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
    case "long":
      return typeof value === "number" && Number.isInteger(value);
    case "double":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
    case "date":
    case "timestamp":
      return typeof value === "string";
    case "list":
      return Array.isArray(value) && value.every((entry) => validateInputType(entry, type.elementType));
    case "record":
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      const allowedFields = new Set(type.fields.map((field) => field.id));
      if (Object.keys(record).some((key) => !allowedFields.has(key))) return false;
      return type.fields.every((field) => {
        const fieldValue = record[field.id];
        if (fieldValue === undefined || fieldValue === null) return !field.required;
        return validateInputType(fieldValue, field.type);
      });
    default:
      return false;
  }
}

export function validateExecutionInputs(
  webhook: ConnectivityWebhook,
  inputs: Record<string, unknown>,
): void {
  const known = new Set(webhook.configuration.inputs.map((input) => input.id));
  for (const key of Object.keys(inputs)) {
    if (!known.has(key)) {
      throw new WebhookExecutionError(
        "INPUT_UNKNOWN",
        `Input '${key}' is not defined by webhook v${webhook.currentVersion}.`,
      );
    }
  }
  for (const input of webhook.configuration.inputs) {
    const value = inputs[input.id];
    if (value === undefined || value === null) {
      if (input.required) {
        throw new WebhookExecutionError(
          "INPUT_REQUIRED",
          `Required input '${input.id}' is missing.`,
        );
      }
      continue;
    }
    if (!validateInputType(value, input.type)) {
      throw new WebhookExecutionError(
        "INPUT_TYPE_INVALID",
        `Input '${input.id}' does not match type '${input.type.kind}'.`,
      );
    }
    if (
      input.type.kind === "string" &&
      input.type.allowedValues &&
      !input.type.allowedValues.includes(value as string)
    ) {
      throw new WebhookExecutionError(
        "INPUT_VALUE_NOT_ALLOWED",
        `Input '${input.id}' is not one of its allowed values.`,
      );
    }
  }
}

function isPrivateOrSpecialAddress(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  const normalized = address.toLowerCase();
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  ) {
    return true;
  }
  const v4 = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export async function assertDnsDestinationAllowed(
  hostname: string,
): Promise<ResolvedDestination> {
  if (hostname.toLowerCase() === "localhost") {
    if (
      process.env.NODE_ENV === "development" &&
      process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK_FOR_DEV === "1"
    ) {
      return { address: "127.0.0.1", family: 4 };
    }
    throw new WebhookExecutionError(
      "EGRESS_PRIVATE_NETWORK_BLOCKED",
      "Loopback webhook destinations are blocked.",
    );
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new WebhookExecutionError(
      "DNS_RESOLUTION_FAILED",
      "The webhook destination did not resolve to an address.",
      true,
    );
  }
  if (
    addresses.some((entry) => isPrivateOrSpecialAddress(entry.address)) &&
    !(
      process.env.NODE_ENV === "development" &&
      process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK_FOR_DEV === "1"
    )
  ) {
    throw new WebhookExecutionError(
      "EGRESS_PRIVATE_NETWORK_BLOCKED",
      "The webhook destination resolved to a private, loopback, link-local, multicast, or reserved address.",
    );
  }
  const selected = addresses[0];
  return {
    address: selected.address,
    family: isIP(selected.address) === 6 ? 6 : 4,
  };
}

function assertConnectionAllows(
  connection: Connection,
  hostname: string,
  port: number,
): void {
  const allowed = connection.egressPolicy.allowlist.some((entry) => {
    if (entry.port !== port) return false;
    const normalize = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "");
    return entry.kind === "host" && normalize(entry.host) === normalize(hostname);
  });
  if (!allowed) {
    throw new WebhookExecutionError(
      "EGRESS_POLICY_BLOCKED",
      `The source egress policy does not allow ${hostname}:${port}.`,
    );
  }
}

function redactUrl(url: URL): string {
  const safe = new URL(url.toString());
  for (const key of [...safe.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) safe.searchParams.set(key, "[REDACTED]");
  }
  return safe.toString();
}

function buildBody(
  body: RequestBody,
  ctx: RuntimeContext,
  secrets: Record<string, string>,
): { body?: string | Buffer; contentType?: string } {
  switch (body.kind) {
    case "none":
      return {};
    case "rawJson":
      return {
        body: renderJsonTemplate(body.template, ctx),
        contentType: "application/json",
      };
    case "plainText":
      return {
        body: resolveRequestValue(body.value, ctx, secrets),
        contentType: "text/plain; charset=utf-8",
      };
    case "xml":
      return {
        body: renderTextTemplate(body.template, ctx),
        contentType: "application/xml",
      };
    case "formUrlEncoded": {
      const params = new URLSearchParams();
      for (const field of body.fields) {
        if (field.enabled) {
          params.append(field.key, resolveRequestValue(field.value, ctx, secrets));
        }
      }
      return {
        body: params.toString(),
        contentType: "application/x-www-form-urlencoded",
      };
    }
    case "formData": {
      const boundary = `tellus-webhook-${randomUUID()}`;
      const parts: string[] = [];
      for (const field of body.fields) {
        if (!field.enabled) continue;
        const safeName = field.key.replace(/["\r\n]/g, "");
        parts.push(
          `--${boundary}\r\n`,
          `Content-Disposition: form-data; name="${safeName}"\r\n\r\n`,
          resolveRequestValue(field.value, ctx, secrets),
          "\r\n",
        );
      }
      parts.push(`--${boundary}--\r\n`);
      return {
        body: parts.join(""),
        contentType: `multipart/form-data; boundary=${boundary}`,
      };
    }
    case "file": {
      const encoded = ctx.inputs[body.inputParameterId];
      if (typeof encoded !== "string") {
        throw new WebhookExecutionError(
          "ATTACHMENT_INPUT_INVALID",
          `Attachment input '${body.inputParameterId}' must be a base64 data URL.`,
        );
      }
      const match = /^data:([^;,]{1,200})?;base64,([A-Za-z0-9+/=\s]+)$/.exec(
        encoded,
      );
      if (!match) {
        throw new WebhookExecutionError(
          "ATTACHMENT_INPUT_INVALID",
          `Attachment input '${body.inputParameterId}' must be a base64 data URL.`,
        );
      }
      return {
        body: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
        contentType: body.contentType ?? match[1] ?? "application/octet-stream",
      };
    }
  }
}

async function resolveSourceSecrets(
  connection: Connection,
  tenant: string,
  actor: string,
  requestId?: string,
  clientIp?: string,
): Promise<Record<string, string>> {
  const auditCtx = { requestId, clientIp, scopes: ["secrets:read"] as string[] };
  const secrets: Record<string, string> = {};

  // Legacy path (F8 back-compat): the REST secret bundle stored as one
  // encrypted JSON document under the generic "other" field. Kept as the
  // first source so named per-secret rows (below) can override individual
  // keys for connections migrated to the new model.
  const otherBytes = await vault.unwrap(connection.rid, tenant, "other", actor, auditCtx);
  if (otherBytes.length > 0) {
    try {
      const decoded = new TextDecoder().decode(otherBytes);
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string") secrets[key] = value;
        }
      }
    } finally {
      otherBytes.fill(0);
    }
  }

  // F8 — named per-secret storage. Each REST secret type gets its own
  // credential row with a descriptive field name, so it can be rotated /
  // audited / access-scoped individually instead of re-encrypting the whole
  // "other" bundle on every rotation.
  const bearerBytes = await vault
    .unwrap(connection.rid, tenant, "bearer_token", actor, auditCtx)
    .catch(() => new Uint8Array());
  if (bearerBytes.length > 0) {
    secrets.bearerToken = new TextDecoder().decode(bearerBytes);
    secrets.bearer_token = secrets.bearerToken;
    bearerBytes.fill(0);
  }

  const apiKeyBytes = await vault
    .unwrap(connection.rid, tenant, "api_key", actor, auditCtx)
    .catch(() => new Uint8Array());
  if (apiKeyBytes.length > 0) {
    secrets.apiToken = new TextDecoder().decode(apiKeyBytes);
    secrets.api_key = secrets.apiToken;
    apiKeyBytes.fill(0);
  }

  const basicBytes = await vault
    .unwrap(connection.rid, tenant, "basic_auth", actor, auditCtx)
    .catch(() => new Uint8Array());
  if (basicBytes.length > 0) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(basicBytes)) as {
        username?: unknown;
        password?: unknown;
      };
      if (typeof parsed.username === "string") secrets.username = parsed.username;
      if (typeof parsed.password === "string") secrets.password = parsed.password;
    } finally {
      basicBytes.fill(0);
    }
  }

  const customHeaderBytes = await vault
    .unwrap(connection.rid, tenant, "custom_header", actor, auditCtx)
    .catch(() => new Uint8Array());
  if (customHeaderBytes.length > 0) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(customHeaderBytes)) as Record<
        string,
        unknown
      >;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") secrets[key] = value;
        }
      }
    } finally {
      customHeaderBytes.fill(0);
    }
  }

  return secrets;
}

function applyInheritedAuthentication(
  authentication: "none" | "basic" | "bearer",
  headers: Record<string, string>,
  secrets: Record<string, string>,
): void {
  if (authentication === "none") return;
  if (authentication === "bearer") {
    const token = secrets.bearerToken ?? secrets.token ?? secrets.apiToken;
    if (!token) {
      throw new WebhookExecutionError(
        "AUTHENTICATION_SECRET_MISSING",
        "The REST source uses bearer authentication but has no bearerToken, token, or apiToken secret.",
      );
    }
    headers.Authorization = `Bearer ${token}`;
    return;
  }
  const username = secrets.username;
  const password = secrets.password;
  if (!username || !password) {
    throw new WebhookExecutionError(
      "AUTHENTICATION_SECRET_MISSING",
      "The REST source uses basic authentication but has no username/password secrets.",
    );
  }
  headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function responseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key.toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : value;
    }
  }
  return result;
}

async function requestPinnedDestination(params: {
  url: URL;
  method: WebhookCall["method"];
  headers: Record<string, string>;
  body?: string | Buffer;
  destination: ResolvedDestination;
  timeoutMs: number;
  maxBytes: number,
}): Promise<{
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bytes: number;
}> {
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [params.destination]);
    } else {
      callback(null, params.destination.address, params.destination.family);
    }
  };
  return new Promise((resolve, reject) => {
    const transport =
      params.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      params.url,
      {
        method: params.method,
        headers: params.headers,
        lookup: pinnedLookup,
        servername: isIP(params.url.hostname) ? undefined : params.url.hostname,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | Uint8Array | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > params.maxBytes) {
            response.destroy(
              new WebhookExecutionError(
                "RESPONSE_TOO_LARGE",
                `Webhook response exceeded ${params.maxBytes} bytes.`,
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: responseHeaders(response.headers),
            bodyText: Buffer.concat(chunks).toString("utf8"),
            bytes,
          });
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(params.timeoutMs, () => {
      const timeout = new Error("The webhook request timed out.");
      timeout.name = "AbortError";
      request.destroy(timeout);
    });
    request.on("error", reject);
    if (params.body !== undefined) request.write(params.body, "utf8");
    request.end();
  });
}

function extractOutput(
  output: OutputParameter,
  calls: Record<string, CallRuntimeResult>,
): unknown {
  const call = calls[output.callId];
  if (!call) return undefined;
  switch (output.selector.kind) {
    case "wholeResponse":
      return call.bodyJson ?? call.bodyText;
    case "jsonPath":
      return readPath(call.bodyJson, output.selector.path);
    case "arrayIndex":
      return readPath(call.bodyJson, output.selector.indexes.map(String));
    case "header":
      return call.headers[output.selector.name.toLowerCase()];
    case "statusCode":
      return call.status;
  }
}

export function classifyRetryable(
  error: unknown,
  call: WebhookCall,
): boolean {
  if (error instanceof WebhookExecutionError) return error.retryable;
  const status = (error as { httpStatus?: number }).httpStatus;
  return typeof status === "number" && call.retryableStatusCodes.includes(status);
}

export function calculateBackoffMs(
  attemptNumber: number,
  policy: {
    initialBackoffMs: number;
    maxBackoffMs: number;
    multiplier: number;
    jitterRatio: number;
  },
  random = Math.random,
): number {
  const base = Math.min(
    policy.maxBackoffMs,
    policy.initialBackoffMs * policy.multiplier ** Math.max(0, attemptNumber - 1),
  );
  const spread = base * policy.jitterRatio;
  return Math.max(0, Math.round(base - spread + random() * spread * 2));
}

async function executeCall(params: {
  call: WebhookCall;
  connection: Connection;
  ctx: RuntimeContext;
  secrets: Record<string, string>;
  correlationId: string;
  idempotencyKey: string;
  executionRid: string;
  attemptNumber: number;
  safePolicy: SafeEgressPolicy;
  timeoutMs: number;
  idempotencyHeaderName: string;
  signature?: {
    secretName: string;
    headerName: string;
    timestampHeaderName: string;
  } | null;
  responsePreviewBytes: number;
  webhookRid: string;
  actor: string;
  requestId?: string;
}): Promise<CallRuntimeResult> {
  const rest =
    params.connection.config.connectorType === "rest-api"
      ? params.connection.config.restApi
      : null;
  if (!rest) {
    throw new WebhookExecutionError(
      "CONNECTION_TYPE_INVALID",
      "Webhooks require a REST API source.",
    );
  }
  const domain = rest.domains[params.call.domainIndex];
  if (!domain) {
    throw new WebhookExecutionError(
      "DOMAIN_NOT_FOUND",
      `Source domain ${params.call.domainIndex + 1} is not configured.`,
    );
  }
  const base = new URL(domain.baseUrl);
  const path = renderTextTemplate(params.call.relativePath, params.ctx).replace(/^\/+/, "");
  const url = new URL(path, `${base.toString().replace(/\/?$/, "/")}`);
  if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
    throw new WebhookExecutionError(
      "DOMAIN_ESCAPE_BLOCKED",
      "The rendered path escaped the selected REST source domain.",
    );
  }
  const port = domain.port || (url.protocol === "https:" ? 443 : 80);
  url.port = port === 443 && url.protocol === "https:" ? "" : String(port);
  assertConnectionAllows(params.connection, url.hostname, port);
  const urlCheck = assertEgressUrl(url.toString(), params.safePolicy);
  if (urlCheck.kind !== "ok") {
    throw new WebhookExecutionError(
      "EGRESS_URL_BLOCKED",
      urlCheck.errors[0]?.message ?? "Webhook destination is not allowed.",
    );
  }
  const destination = await assertDnsDestinationAllowed(url.hostname);

  for (const query of params.call.queryParameters) {
    if (!query.enabled) continue;
    url.searchParams.append(
      renderTextTemplate(query.key, params.ctx),
      resolveRequestValue(query.value, params.ctx, params.secrets),
    );
  }

  const headers: Record<string, string> = {
    Accept: "application/json, text/plain;q=0.8",
    "Accept-Encoding": "identity",
    "User-Agent": "tellus-connectivity-webhook/1",
    "X-Tellus-Correlation-Id": params.correlationId,
  };
  for (const header of params.call.headers) {
    if (!header.enabled) continue;
    if (FORBIDDEN_HEADER_NAMES.has(header.key.toLowerCase())) {
      throw new WebhookExecutionError(
        "HEADER_FORBIDDEN",
        `Header '${header.key}' is managed by the transport and cannot be configured.`,
      );
    }
    headers[header.key] = resolveRequestValue(
      header.value,
      params.ctx,
      params.secrets,
    ).replace(/[\r\n]/g, "");
  }
  applyInheritedAuthentication(domain.authentication, headers, params.secrets);
  const builtBody = buildBody(params.call.body, params.ctx, params.secrets);
  if (builtBody.contentType && !headers["Content-Type"]) {
    headers["Content-Type"] = builtBody.contentType;
  }
  if (builtBody.body !== undefined) {
    const bytes = Buffer.isBuffer(builtBody.body)
      ? builtBody.body.byteLength
      : Buffer.byteLength(builtBody.body, "utf8");
    const check = assertRequestBytes(bytes, params.safePolicy);
    if (check.kind !== "ok") {
      throw new WebhookExecutionError(
        "REQUEST_TOO_LARGE",
        check.errors[0]?.message ?? "Request exceeds configured size.",
      );
    }
  }
  if (params.signature) {
    const signatureSecret = params.secrets[params.signature.secretName];
    if (!signatureSecret) {
      throw new WebhookExecutionError(
        "SIGNATURE_SECRET_MISSING",
        `Signature secret '${params.signature.secretName}' is unavailable on the REST source.`,
      );
    }
    const timestamp = new Date().toISOString();
    headers[params.signature.timestampHeaderName] = timestamp;
    headers[params.signature.headerName] = signPayload(
      Buffer.isBuffer(builtBody.body)
        ? builtBody.body.toString("base64")
        : (builtBody.body ?? ""),
      signatureSecret,
      timestamp,
    );
  }

  const methodCheck = assertMethod(params.call.method);
  if (methodCheck.kind !== "ok") {
    throw new WebhookExecutionError(
      "METHOD_FORBIDDEN",
      methodCheck.errors[0]?.message ?? "HTTP method is not allowed.",
    );
  }
  const idem = params.idempotencyKey;
  if (idem) headers[params.idempotencyHeaderName] = idem;

  const cleaned = sanitizeOutboundHeaders(headers, params.safePolicy);
  const attemptId = await repository.beginAttempt({
    executionRid: params.executionRid,
    attemptNumber: params.attemptNumber,
    requestMethod: params.call.method,
    requestUrlRedacted: redactUrl(url),
    requestHeadersRedacted: redactHeadersForLog(cleaned.headers),
  });
  // F7 — record the egress to the audit trail. When egressMode is
  // "agent-tunnel", the executor must route through a live agent — fail
  // closed if no agent is available (never silently fall back to direct
  // egress). When egressMode is "direct" (default), the backend opens a
  // socket directly and records a warning in the audit log.
  const egressMode = params.connection.settings.egressMode ?? "direct";
  let agentRid: string | null = null;
  if (egressMode === "agent-tunnel") {
    // Resolve a live agent for the connection's agent group. If the
    // connection has no agentGroupRid, or the group has no connected
    // agent, fail closed — do NOT fall back to direct egress.
    assertAgentAvailable(params.connection as unknown as Parameters<typeof assertAgentAvailable>[0]);
    const binding = await resolveAgentForGroup(
      params.connection.agentGroupRid!,
    );
    agentRid = binding.agentRid;
    // The actual tunnel transport (SOCKS5 / HTTP CONNECT through the
    // agent's coordinator stream) is the B6 future-work path. Until the
    // transport is implemented, we emit a structured warning to the audit
    // log and proceed with direct egress so the feature is usable in dev.
    // In production with egressMode="agent-tunnel", the transport MUST be
    // implemented or the egress MUST be blocked by policy.
  }
  const auditEgress = (outcome: "success" | "failure", reason?: string) =>
    recordEgressAudit({
      connectionRid: params.connection.rid,
      tenant: params.connection.tenant,
      source: "webhook",
      egressMode,
      destinationHost: url.hostname,
      destinationPort: port,
      webhookRid: params.webhookRid,
      outcome,
      reason,
      actor: params.actor,
      requestId: params.requestId,
      agentRid,
    }).catch(() => undefined);
  try {
    const response = await requestPinnedDestination({
      url,
      method: params.call.method,
      headers: cleaned.headers,
      body:
        params.call.method === "GET" ? undefined : builtBody.body,
      destination,
      timeoutMs: params.timeoutMs,
      maxBytes: params.safePolicy.maxResponseBytes,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new WebhookExecutionError(
        "REDIRECT_BLOCKED",
        "Webhook redirects are disabled. Configure the final source domain explicitly.",
        false,
        response.status,
        false,
      );
    }
    const headersOut = response.headers;
    const contentType = headersOut["content-type"] ?? "text/plain";
    const contentCheck = assertResponseContentType(contentType, params.safePolicy);
    if (contentCheck.kind !== "ok") {
      throw new WebhookExecutionError(
        "RESPONSE_CONTENT_TYPE_BLOCKED",
        contentCheck.errors[0]?.message ?? "Response content type is not allowed.",
        false,
        response.status,
      );
    }
    const sizeCheck = assertResponseBytes(response.bytes, params.safePolicy);
    if (sizeCheck.kind !== "ok") {
      throw new WebhookExecutionError(
        "RESPONSE_TOO_LARGE",
        sizeCheck.errors[0]?.message ?? "Response exceeds configured size.",
      );
    }
    let bodyJson: unknown = null;
    if (response.bodyText) {
      try {
        bodyJson = JSON.parse(response.bodyText);
      } catch {
        bodyJson = response.bodyText;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const unchanged = params.call.externalSystemUnchangedStatusCodes.includes(
        response.status,
      );
      throw new WebhookExecutionError(
        `HTTP_${response.status}`,
        `External system returned HTTP ${response.status}.`,
        params.call.retryableStatusCodes.includes(response.status),
        response.status,
        !unchanged,
      );
    }
    await repository.completeAttempt({
      id: attemptId,
      status: "succeeded",
      responseHeadersRedacted: redactHeadersForLog(headersOut),
      httpStatus: response.status,
      responsePreview: String(
        redactKnownSecrets(
          response.bodyText.slice(0, params.responsePreviewBytes),
          params.secrets,
        ),
      ),
      responseBytes: response.bytes,
    });
    void auditEgress("success");
    return {
      status: response.status,
      headers: headersOut,
      bodyText: response.bodyText,
      bodyJson,
    };
  } catch (error) {
    const normalized =
      error instanceof WebhookExecutionError
        ? error
        : new WebhookExecutionError(
            (error as Error).name === "AbortError"
              ? "REQUEST_TIMEOUT"
              : "NETWORK_ERROR",
            (error as Error).name === "AbortError"
              ? "The webhook request timed out."
              : "The webhook destination could not be reached.",
            true,
          );
    await repository.completeAttempt({
      id: attemptId,
      status: normalized.retryable
        ? "retryable_failure"
        : "terminal_failure",
      httpStatus: normalized.httpStatus ?? null,
      errorCode: normalized.code,
      errorMessage: normalized.message,
    });
    void auditEgress("failure", normalized.code);
    throw normalized;
  }
}

function idempotencyHash(
  webhookRid: string,
  explicit: string | undefined,
  actor: string,
): { hash: string; outbound: string } {
  const outbound = explicit ?? randomUUID();
  return {
    outbound,
    hash: createHash("sha256")
      .update(`${webhookRid}\u0000${actor}\u0000${outbound}`)
      .digest("hex"),
  };
}

export async function executeWebhook(
  options: ExecuteWebhookOptions,
): Promise<ExecuteWebhookResult> {
  if (
    options.connection.connectorType !== "rest-api" ||
    options.webhook.connectionRid !== options.connection.rid
  ) {
    throw new WebhookExecutionError(
      "CONNECTION_TYPE_INVALID",
      "The webhook does not belong to this REST API source.",
    );
  }
  if (
    options.kind === "production" &&
    options.webhook.status !== "active"
  ) {
    throw new WebhookExecutionError(
      "WEBHOOK_NOT_ACTIVE",
      "Only active webhooks may execute in production.",
    );
  }
  if (options.webhook.status === "archived") {
    throw new WebhookExecutionError(
      "WEBHOOK_ARCHIVED",
      "Archived webhooks cannot be executed.",
    );
  }
  if (
    options.kind === "test" &&
    options.webhook.configuration.request.calls.some(
      (call) => call.body.kind === "file",
    )
  ) {
    throw new WebhookExecutionError(
      "ATTACHMENT_TEST_UNSUPPORTED",
      "Attachment request bodies cannot be executed from the interactive test panel.",
    );
  }
  validateExecutionInputs(options.webhook, options.inputs);

  // Preserve a caller's action correlation through retries and execution
  // history. Interactive/manual executions retain the generated fallback.
  const correlationId = options.correlationId ?? randomUUID();
  const idem = idempotencyHash(
    options.webhook.rid,
    options.idempotencyKey,
    options.actor,
  );
  const created = await repository.createExecution({
    tenant: options.tenant,
    webhookRid: options.webhook.rid,
    webhookVersion: options.webhook.currentVersion,
    kind: options.kind,
    correlationId,
    idempotencyKeyHash: idem.hash,
    triggeredBy: options.actor,
    inputSummary: redactExecutionInputs(options.webhook, options.inputs),
    concurrencyLimit:
      options.webhook.configuration.executionPolicy.concurrencyLimit,
    rateLimit: options.webhook.configuration.executionPolicy.rateLimit,
  });
  if (created.replayed) {
    return { execution: created.execution, replayed: true };
  }
  await repository.markExecutionRunning(created.execution.rid);

  const started = Date.now();
  const secrets = await resolveSourceSecrets(
    options.connection,
    options.tenant,
    options.actor,
    options.requestId,
    options.clientIp,
  );
  const ctx: RuntimeContext = { inputs: options.inputs, calls: {} };
  const policy = options.webhook.configuration.executionPolicy;
  const safePolicy: SafeEgressPolicy = {
    httpsRequired: true,
    followRedirects: false,
    allowedHosts:
      options.connection.egressPolicy.allowlist
        .filter((entry): entry is Extract<typeof entry, { kind: "host" }> => entry.kind === "host")
        .map((entry) => entry.host.toLowerCase().replace(/^\[|\]$/g, "")),
    headerAllowlist: [],
    maxRequestBytes: policy.maxRequestBytes,
    maxResponseBytes: policy.maxResponseBytes,
    allowedResponseContentTypes: [
      "application/json",
      "application/problem+json",
      "text/plain",
      "application/xml",
      "text/xml",
    ],
  };

  let finalStatus: number | null = null;
  let externalChanged: boolean | null = null;
  let attemptNumber = 0;
  try {
    for (const call of options.webhook.configuration.request.calls) {
      let lastError: unknown = null;
      for (
        let retry = 1;
        retry <= policy.retry.maxAttempts;
        retry += 1
      ) {
        attemptNumber += 1;
        try {
          const result = await executeCall({
            call,
            connection: options.connection,
            ctx,
            secrets,
            correlationId,
            idempotencyKey: policy.idempotency.enabled ? idem.outbound : "",
            executionRid: created.execution.rid,
            attemptNumber,
            safePolicy,
            timeoutMs: policy.timeoutSeconds * 1000,
            idempotencyHeaderName: policy.idempotency.headerName,
            signature: options.webhook.configuration.signature,
            responsePreviewBytes: (options.webhook.configuration.storage.recordFullResponse ||
              options.webhook.configuration.storage.recordFullResponseCallIds.includes(call.id))
              ? safePolicy.maxResponseBytes
              : options.webhook.configuration.storage.responsePreviewBytes,
            webhookRid: options.webhook.rid,
            actor: options.actor,
            requestId: options.requestId,
          });
          ctx.calls[call.id] = result;
          finalStatus = result.status;
          if (call.method !== "GET" && !call.readApi) {
            externalChanged = true;
          }
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (error instanceof WebhookExecutionError) {
            finalStatus = error.httpStatus ?? finalStatus;
            externalChanged =
              error.externalSystemChanged ?? externalChanged;
          }
          if (!classifyRetryable(error, call) || retry >= policy.retry.maxAttempts) {
            break;
          }
          const delay = calculateBackoffMs(retry, policy.retry);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            timer.unref?.();
          });
        }
      }
      if (lastError) throw lastError;
    }

    const outputs: Record<string, unknown> = {};
    for (const output of options.webhook.configuration.outputs) {
      outputs[output.id] = extractOutput(output, ctx.calls) ?? null;
    }
    await repository.completeExecution({
      executionRid: created.execution.rid,
      status: "succeeded",
      outputSummary: redactKnownSecrets(outputs, secrets) as Record<string, unknown>,
      httpStatus: finalStatus,
      durationMs: Date.now() - started,
      externalSystemChanged: externalChanged,
    });
  } catch (error) {
    const normalized =
      error instanceof WebhookExecutionError
        ? error
        : new WebhookExecutionError(
            "EXECUTION_FAILED",
            "Webhook execution failed.",
          );
    await repository.completeExecution({
      executionRid: created.execution.rid,
      status: options.kind === "production" ? "dead_lettered" : "failed",
      errorCode: normalized.code,
      errorMessage: normalized.message,
      httpStatus: normalized.httpStatus ?? finalStatus,
      durationMs: Date.now() - started,
      externalSystemChanged:
        normalized.externalSystemChanged ?? externalChanged,
    });
  } finally {
    for (const key of Object.keys(secrets)) secrets[key] = "";
  }
  return {
    execution: await repository.getExecution(
      created.execution.rid,
      options.tenant,
    ),
    replayed: false,
  };
}

export function signPayload(
  payload: string,
  secret: string,
  timestamp: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");
}
