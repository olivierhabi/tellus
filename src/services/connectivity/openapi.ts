// ---------------------------------------------------------------------------
// OpenAPI 3.1 emission for the Connectivity surface (B1 § 59).
//
// `@asteasolutions/zod-to-openapi` is the canonical bridge: it accepts the
// same Zod contracts we already use at the handler layer and produces an
// OpenAPI document that `openapi-typescript` consumes to generate the
// frontend client (`tellus-fe/lib/api/connectivity.gen.ts`).
//
// Add to package.json:
//   "dependencies": { "@asteasolutions/zod-to-openapi": "^7.3.0" }
// and the matching `openapi-typescript` 6.x at the frontend side.
//
// CLI entry: scripts/generate-openapi-connectivity.ts invokes
// buildOpenApiDocument() and writes openapi/connectivity.yaml.
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

import {
  AgentGroupRid,
  CompassFolderRid,
  Connection,
  ConnectionConfig,
  ConnectionCreateRequest,
  ConnectionListResponse,
  ConnectionRid,
  ConnectionStatus,
  ConnectionUpdateRequest,
  ConnectorType,
  Driver,
  EgressMode,
  EgressPolicy,
  ErrorEnvelopeSchema,
  NamedEgressPolicy,
  EgressPolicyCreateRequest,
  EgressPolicyUpdateRequest,
  EgressPolicyDecisionRequest,
  EgressPolicyListResponse,
  PostgresConfig,
  RestApiConfig,
  RestApiDomainConfig,
  TableImport,
  TlsMode,
  VirtualTable,
  WorkerType,
  ConnectorTypeListResponse,
} from "./contracts";
import {
  WebhookCreateRequest,
  WebhookExecuteRequest,
  WebhookUpdateRequest,
  WebhookLifecycleStatus,
  WebhookVersionConfiguration,
} from "./webhooks/contracts";
import {
  TableImportCreateRequest,
  TableImportUpdateRequest,
} from "./imports/contracts";
import {
  VirtualTableCreateRequest,
} from "./virtual-tables/contracts";
import {
  CdcImportCreateRequest,
  PreflightResult,
} from "./cdc/contracts";

extendZodWithOpenApi(z);

/** Build the OpenAPI 3.1 document object. */
export function buildOpenApiDocument(): ReturnType<
  OpenApiGeneratorV31["generateDocument"]
> {
  const registry = new OpenAPIRegistry();

  // --- shared components ----------------------------------------------------
  registry.register("ConnectionRid", ConnectionRid);
  registry.register("CompassFolderRid", CompassFolderRid);
  registry.register("AgentGroupRid", AgentGroupRid);
  registry.register("ConnectorType", ConnectorType);
  registry.register("WorkerType", WorkerType);
  registry.register("TlsMode", TlsMode);
  registry.register("PostgresConfig", PostgresConfig);
  registry.register("RestApiDomainConfig", RestApiDomainConfig);
  registry.register("RestApiConfig", RestApiConfig);
  registry.register("ConnectionConfig", ConnectionConfig);
  registry.register("EgressPolicy", EgressPolicy);
  registry.register("ConnectionStatus", ConnectionStatus);
  registry.register("Connection", Connection);
  registry.register("ConnectionCreateRequest", ConnectionCreateRequest);
  registry.register("ConnectionUpdateRequest", ConnectionUpdateRequest);
  registry.register("ConnectionListResponse", ConnectionListResponse);
  registry.register("TableImport", TableImport);
  registry.register("VirtualTable", VirtualTable);
  registry.register("Driver", Driver);
  registry.register("ErrorEnvelope", ErrorEnvelopeSchema);
  registry.register("NamedEgressPolicy", NamedEgressPolicy);
  registry.register("EgressPolicyCreateRequest", EgressPolicyCreateRequest);
  registry.register("EgressPolicyUpdateRequest", EgressPolicyUpdateRequest);
  registry.register("EgressPolicyDecisionRequest", EgressPolicyDecisionRequest);
  registry.register("EgressPolicyListResponse", EgressPolicyListResponse);
  registry.register("ConnectorTypeListResponse", ConnectorTypeListResponse);
  registry.register("EgressMode", EgressMode);
  registry.register("WebhookLifecycleStatus", WebhookLifecycleStatus);
  registry.register("WebhookVersionConfiguration", WebhookVersionConfiguration);
  registry.register("WebhookCreateRequest", WebhookCreateRequest);
  registry.register("WebhookUpdateRequest", WebhookUpdateRequest);
  registry.register("WebhookExecuteRequest", WebhookExecuteRequest);
  registry.register("TableImportCreateRequest", TableImportCreateRequest);
  registry.register("TableImportUpdateRequest", TableImportUpdateRequest);
  registry.register("VirtualTableCreateRequest", VirtualTableCreateRequest);
  registry.register("CdcImportCreateRequest", CdcImportCreateRequest);
  registry.register("PreflightResult", PreflightResult);

  // F8 — named per-secret storage. The credential field vocabulary is
  // extended beyond the original ("password"|"client_key"|
  // "service_account_json"|"token"|"other") to include descriptive REST-API
  // secret names so each secret type gets its own credential row.
  const CredentialFieldEnum = z.enum([
    "password",
    "client_key",
    "service_account_json",
    "token",
    "other",
    "api_key",
    "bearer_token",
    "basic_auth",
    "custom_header",
  ]);
  registry.register("CredentialField", CredentialFieldEnum);

  // RID brands for path params.
  const WebhookRid = z
    .string()
    .regex(/^ri\.magritte\.main\.webhook\.[0-9a-f-]{36}$/)
    .brand<"WebhookRid">();
  const EgressPolicyRidParam = z
    .string()
    .regex(
      /^ri\.magritte\.main\.egress-policy\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    .brand<"EgressPolicyRid">();
  const TableImportRidParam = z
    .string()
    .regex(/^ri\.magritte\.main\.extract\.[0-9a-f-]{36}$/)
    .brand<"TableImportRid">();
  const VirtualTableRidParam = z
    .string()
    .regex(/^ri\.magritte\.main\.virtual-table\.[0-9a-f-]{36}$/)
    .brand<"VirtualTableRid">();
  const BuildRidParam = z
    .string()
    .regex(/^ri\.magritte\.main\.build\.[0-9a-f-]{36}$/)
    .brand<"BuildRid">();
  const WebhookExecutionRidParam = z
    .string()
    .regex(/^ri\.magritte\.main\.webhook-execution\.[0-9a-f-]{36}$/)
    .brand<"WebhookExecutionRid">();
  registry.register("WebhookRid", WebhookRid);
  registry.register("EgressPolicyRid", EgressPolicyRidParam);
  registry.register("TableImportRid", TableImportRidParam);
  registry.register("VirtualTableRid", VirtualTableRidParam);
  registry.register("BuildRid", BuildRidParam);
  registry.register("WebhookExecutionRid", WebhookExecutionRidParam);

  // F8 — body schemas for the secrets endpoints, reusing the extended
  // CredentialField vocabulary.
  const PostSecretBody = z.object({
    field: CredentialFieldEnum,
    plaintext_base64: z.string().min(1).max(64 * 1024),
  });
  const RotateSecretBody = z.object({
    plaintext_base64: z.string().min(1).max(64 * 1024),
  });
  registry.register("PostSecretBody", PostSecretBody);
  registry.register("RotateSecretBody", RotateSecretBody);

  // Webhook response shape (the ConnectivityWebhook runtime object; built
  // inline because the canonical contract is a TS interface, not a Zod
  // schema).
  const WebhookResponse = z.object({
    rid: WebhookRid,
    tenant: z.string(),
    connectionRid: ConnectionRid,
    apiName: z.string(),
    displayName: z.string(),
    description: z.string(),
    status: WebhookLifecycleStatus,
    currentVersion: z.number().int(),
    configuration: WebhookVersionConfiguration,
    createdAt: z.string().datetime(),
    createdBy: z.string(),
    updatedAt: z.string().datetime(),
    updatedBy: z.string(),
  });
  registry.register("WebhookResponse", WebhookResponse);

  const WebhookExecutionResponse = z.object({
    rid: WebhookExecutionRidParam,
    webhookRid: WebhookRid,
    webhookVersion: z.number().int(),
    kind: z.enum(["test", "production"]),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "dead_lettered",
    ]),
    correlationId: z.string().uuid(),
    triggeredBy: z.string(),
    inputSummary: z.record(z.string(), z.unknown()),
    outputSummary: z.record(z.string(), z.unknown()).nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    httpStatus: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    externalSystemChanged: z.boolean().nullable(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  });
  registry.register("WebhookExecutionResponse", WebhookExecutionResponse);

  const CredentialResult = z.object({
    connectionRid: ConnectionRid,
    field: CredentialFieldEnum,
    version: z.number().int(),
  });
  registry.register("CredentialResult", CredentialResult);

  const ErrorContent = {
    "application/json": { schema: ErrorEnvelopeSchema },
  };

  // --- security: Multipass bearer ------------------------------------------
  registry.registerComponent("securitySchemes", "multipass", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT (Multipass)",
    description:
      "Multipass-issued JWT. Scopes: connectivity:read, connectivity:write.",
  });

  // --- POST /connections ----------------------------------------------------
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections",
    summary: "Create a new connection.",
    description:
      "Creates a connection bound to a Compass folder. Atomic with Compass " +
      "registration via transactional outbox. Idempotent under Idempotency-Key " +
      "for 24h.",
    tags: ["connectivity"],
    security: [{ multipass: ["connectivity:write"] }],
    request: {
      headers: z.object({
        "idempotency-key": z
          .string()
          .uuid()
          .optional()
          .openapi({ description: "UUIDv4; replays response for 24h." }),
      }),
      body: {
        content: { "application/json": { schema: ConnectionCreateRequest } },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Created. ETag returned for subsequent If-Match.",
        headers: {
          ETag: { schema: { type: "string" }, description: 'W/"<version>"' },
          Location: { schema: { type: "string" } },
        },
        content: { "application/json": { schema: Connection } },
      },
      400: { description: "Invalid configuration.", content: ErrorContent },
      403: { description: "Permission denied.", content: ErrorContent },
      404: { description: "Folder not found.", content: ErrorContent },
      409: { description: "Name conflict.", content: ErrorContent },
    },
  });

  // --- GET /connections/{rid} ----------------------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/connections/{rid}",
    summary: "Get a connection by RID.",
    tags: ["connectivity"],
    security: [{ multipass: ["connectivity:read"] }],
    request: { params: z.object({ rid: ConnectionRid }) },
    responses: {
      200: {
        description: "OK. ETag emitted for OCC.",
        headers: { ETag: { schema: { type: "string" } } },
        content: { "application/json": { schema: Connection } },
      },
      404: { description: "Not found.", content: ErrorContent },
    },
  });

  // --- GET /connections (list) ---------------------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/connections",
    summary: "List connections (paginated).",
    tags: ["connectivity"],
    security: [{ multipass: ["connectivity:read"] }],
    request: {
      query: z.object({
        folderRid: CompassFolderRid.optional(),
        connectorType: ConnectorType.optional(),
        pageSize: z.coerce.number().int().min(1).max(200).optional(),
        pageToken: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Page of connections.",
        content: { "application/json": { schema: ConnectionListResponse } },
      },
    },
  });

  // --- PUT /connections/{rid} ----------------------------------------------
  registry.registerPath({
    method: "put",
    path: "/api/v1/connectivity/connections/{rid}",
    summary: "Update a connection (OCC via If-Match).",
    tags: ["connectivity"],
    security: [{ multipass: ["connectivity:write"] }],
    request: {
      params: z.object({ rid: ConnectionRid }),
      headers: z.object({
        "if-match": z
          .string()
          .regex(/^(?:W\/)?"\d+"$/)
          .openapi({ description: 'Weak ETag form W/"<version>"' }),
      }),
      body: {
        content: { "application/json": { schema: ConnectionUpdateRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Updated. ETag bumped.",
        headers: { ETag: { schema: { type: "string" } } },
        content: { "application/json": { schema: Connection } },
      },
      404: { description: "Not found.", content: ErrorContent },
      409: {
        description: "Version mismatch (Tellus:Connectivity:ResourceVersionMismatch).",
        content: ErrorContent,
      },
      412: {
        description: "If-Match missing or malformed.",
        content: ErrorContent,
      },
    },
  });

  // --- DELETE /connections/{rid} -------------------------------------------
  registry.registerPath({
    method: "delete",
    path: "/api/v1/connectivity/connections/{rid}",
    summary: "Soft-delete a connection (OCC via If-Match).",
    description:
      "Sets deleted_at; excludes from list; returns 404 on subsequent read. " +
      "Rejects 412 when active TableImports / VirtualTables reference the " +
      "connection (Tellus:Connectivity:HasActiveDependencies).",
    tags: ["connectivity"],
    security: [{ multipass: ["connectivity:write"] }],
    request: {
      params: z.object({ rid: ConnectionRid }),
      headers: z.object({
        "if-match": z.string().regex(/^(?:W\/)?"\d+"$/),
      }),
    },
    responses: {
      204: { description: "Deleted." },
      404: { description: "Not found.", content: ErrorContent },
      409: { description: "Version mismatch.", content: ErrorContent },
      412: {
        description: "If-Match missing or active dependencies.",
        content: ErrorContent,
      },
    },
  });

  // --- GET /connections/{rid}/configuration --------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/connections/{rid}/configuration",
    summary: "Get the operator-visible configuration (no secrets).",
    tags: ["connectivity"],
    security: [{ multipass: ["connectivity:read"] }],
    request: { params: z.object({ rid: ConnectionRid }) },
    responses: {
      200: {
        description: "Configuration view.",
        headers: { ETag: { schema: { type: "string" } } },
        content: {
          "application/json": {
            schema: z.object({
              rid: ConnectionRid,
              connectorType: ConnectorType,
              workerType: WorkerType,
              agentGroupRid: AgentGroupRid.optional(),
              config: ConnectionConfig,
              egressPolicy: EgressPolicy,
            }),
          },
        },
      },
      404: { description: "Not found.", content: ErrorContent },
    },
  });

  // --- GET /connections/{rid}/status ---------------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/connections/{rid}/status",
    summary: "Get last-known connectivity status.",
    tags: ["connectivity"],
    security: [{ multipass: ["connectivity:read"] }],
    request: { params: z.object({ rid: ConnectionRid }) },
    responses: {
      200: {
        description: "Status snapshot.",
        headers: { ETag: { schema: { type: "string" } } },
        content: {
          "application/json": {
            schema: z.object({
              rid: ConnectionRid,
              state: ConnectionStatus.shape.state,
              lastCheckedAt: ConnectionStatus.shape.lastCheckedAt,
              details: ConnectionStatus.shape.details,
            }),
          },
        },
      },
      404: { description: "Not found.", content: ErrorContent },
    },
  });

  // =========================================================================
  // F5 — Remaining mounted routes (src/services/connectivity/index.ts).
  // Every route below was previously undocumented. Routes with existing Zod
  // contracts carry full request/response schemas; routes whose response
  // shape is a free-form JSON payload use `z.unknown()` per the audit's
  // "minimum method+path+summary" allowance.
  // =========================================================================

  const ReadScope = [{ multipass: ["connectivity:read"] }];
  const WriteScope = [{ multipass: ["connectivity:write"] }];
  const IdemHeader = z.object({
    "idempotency-key": z
      .string()
      .uuid()
      .optional()
      .openapi({ description: "UUIDv4; replays response for 24h." }),
  });
  const IfMatchHeader = z.object({
    "if-match": z.string().regex(/^(?:W\/)?"\d+"$/),
  });

  // --- connector-types -----------------------------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/connector-types",
    summary: "List connector types for the source picker.",
    tags: ["connectivity"],
    security: ReadScope,
    responses: {
      200: {
        description: "Connector type registry.",
        content: { "application/json": { schema: ConnectorTypeListResponse } },
      },
    },
  });

  // --- folders -------------------------------------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/folders",
    summary: "List Compass folders/spaces for the folder picker.",
    tags: ["connectivity"],
    security: ReadScope,
    responses: {
      200: {
        description: "Folders.",
        content: { "application/json": { schema: z.unknown() } },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/folders",
    summary: "Create an output folder (idempotent by parent+name).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      headers: IdemHeader,
      body: { content: { "application/json": { schema: z.unknown() } }, required: true },
    },
    responses: {
      201: { description: "Created or existing.", content: { "application/json": { schema: z.unknown() } } },
      403: { description: "Permission denied.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/folders/{rid}",
    summary: "Resolve a single folder-like resource by RID.",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ rid: CompassFolderRid }) },
    responses: {
      200: { description: "Folder.", content: { "application/json": { schema: z.unknown() } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });

  // --- egress-policies -----------------------------------------------------
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/egress-policies",
    summary: "Create a named egress policy (PENDING until approved).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      headers: IdemHeader,
      body: { content: { "application/json": { schema: EgressPolicyCreateRequest } }, required: true },
    },
    responses: {
      201: { description: "Created.", content: { "application/json": { schema: NamedEgressPolicy } } },
      400: { description: "Invalid.", content: ErrorContent },
      409: { description: "Name conflict.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/egress-policies",
    summary: "List named egress policies.",
    tags: ["connectivity"],
    security: ReadScope,
    request: {
      query: z.object({
        status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
        pageSize: z.coerce.number().int().min(1).max(200).optional(),
        pageToken: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Page.", content: { "application/json": { schema: EgressPolicyListResponse } } },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/egress-policies/{eprid}",
    summary: "Get a named egress policy.",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ eprid: EgressPolicyRidParam }) },
    responses: {
      200: { description: "Policy.", content: { "application/json": { schema: NamedEgressPolicy } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "put",
    path: "/api/v1/connectivity/egress-policies/{eprid}",
    summary: "Update a named egress policy (resets status to PENDING).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ eprid: EgressPolicyRidParam }),
      headers: IfMatchHeader,
      body: { content: { "application/json": { schema: EgressPolicyUpdateRequest } }, required: true },
    },
    responses: {
      200: { description: "Updated.", content: { "application/json": { schema: NamedEgressPolicy } } },
      404: { description: "Not found.", content: ErrorContent },
      412: { description: "If-Match missing/mismatch.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/v1/connectivity/egress-policies/{eprid}",
    summary: "Delete a named egress policy.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ eprid: EgressPolicyRidParam }),
      headers: IfMatchHeader,
    },
    responses: {
      204: { description: "Deleted." },
      404: { description: "Not found.", content: ErrorContent },
      412: { description: "If-Match missing/mismatch.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/egress-policies/{eprid}/decision",
    summary: "Approve or reject a PENDING egress policy.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ eprid: EgressPolicyRidParam }),
      body: { content: { "application/json": { schema: EgressPolicyDecisionRequest } }, required: true },
    },
    responses: {
      200: { description: "Decision recorded.", content: { "application/json": { schema: NamedEgressPolicy } } },
      404: { description: "Not found.", content: ErrorContent },
      409: { description: "Not PENDING.", content: ErrorContent },
    },
  });

  // --- test ----------------------------------------------------------------
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/test-config",
    summary: "Transient connection probe (no persisted connection).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              host: z.string(),
              port: z.number().int(),
              database: z.string(),
              user: z.string(),
              password: z.string(),
              tlsMode: z.string(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Probe result.",
        content: {
          "application/json": {
            schema: z.object({ ok: z.boolean(), latencyMs: z.number().int(), serverVersion: z.string().optional() }),
          },
        },
      },
      429: { description: "Rate limited.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/test",
    summary: "On-demand probe of an existing connection.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ rid: ConnectionRid }),
      headers: IdemHeader,
    },
    responses: {
      200: {
        description: "Probe result.",
        content: {
          "application/json": {
            schema: z.object({ ok: z.boolean(), latencyMs: z.number().int(), serverVersion: z.string().optional() }),
          },
        },
      },
      404: { description: "Not found.", content: ErrorContent },
      429: { description: "Rate limited.", content: ErrorContent },
    },
  });

  // --- secrets -------------------------------------------------------------
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/secrets",
    summary: "Write a credential into the vault (named per-secret, F8).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ rid: ConnectionRid }),
      headers: z.object({ "if-match": z.string().regex(/^(?:W\/)?"\d+"$/), "idempotency-key": z.string().uuid().optional() }),
      body: { content: { "application/json": { schema: PostSecretBody } }, required: true },
    },
    responses: {
      201: { description: "Created.", content: { "application/json": { schema: CredentialResult } } },
      404: { description: "Connection not found.", content: ErrorContent },
      412: { description: "If-Match missing/mismatch.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "put",
    path: "/api/v1/connectivity/connections/{rid}/secrets/{name}",
    summary: "Replace the named credential field's material.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ rid: ConnectionRid, name: CredentialFieldEnum }),
      headers: IfMatchHeader,
      body: { content: { "application/json": { schema: z.object({ plaintext_base64: z.string().min(1).max(64 * 1024) }) } }, required: true },
    },
    responses: {
      201: { description: "Replaced.", content: { "application/json": { schema: CredentialResult } } },
      404: { description: "Not found.", content: ErrorContent },
      412: { description: "If-Match missing/mismatch.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/v1/connectivity/connections/{rid}/secrets/{name}",
    summary: "Supersede (delete) a named credential field.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ rid: ConnectionRid, name: CredentialFieldEnum }),
      headers: IfMatchHeader,
    },
    responses: {
      204: { description: "Superseded." },
      404: { description: "Not found.", content: ErrorContent },
      412: { description: "If-Match missing/mismatch.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/secrets/{name}/rotate",
    summary: "Force a new version of a named credential (caller-supplied plaintext).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ rid: ConnectionRid, name: CredentialFieldEnum }),
      headers: IdemHeader,
      body: { content: { "application/json": { schema: RotateSecretBody } }, required: true },
    },
    responses: {
      200: { description: "Rotated.", content: { "application/json": { schema: CredentialResult } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/secrets/{name}/rotate-managed",
    summary: "Server-side managed rotation (generates fresh material in-process).",
    tags: ["connectivity"],
    security: [{ multipass: ["secrets:rotate"] }],
    request: {
      params: z.object({ rid: ConnectionRid, name: CredentialFieldEnum }),
      headers: z.object({ "if-match": z.string().regex(/^(?:W\/)?"\d+"$/), "idempotency-key": z.string().uuid().optional() }),
    },
    responses: {
      200: { description: "Rotated.", content: { "application/json": { schema: CredentialResult.extend({ rotated: z.boolean() }) } } },
      500: { description: "Rotation failed.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/credentials/issue",
    summary: "Internal unwrap — returns plaintext credentials (workload-JWT gated).",
    tags: ["connectivity"],
    security: [],
    request: {
      params: z.object({ rid: ConnectionRid }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              connection_rid: z.string().optional(),
              field: CredentialFieldEnum.optional(),
              workload_token: z.string().min(1),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: { description: "Credential set.", content: { "application/json": { schema: z.unknown() } } },
      403: { description: "Workload token invalid.", content: ErrorContent },
      404: { description: "Credential not found.", content: ErrorContent },
    },
  });

  // --- internal unwrap -----------------------------------------------------
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/internal/credentials/unwrap",
    summary: "Worker credential unwrap (workload-JWT gated; cluster-internal).",
    tags: ["connectivity"],
    security: [],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              connectionRid: z.string().regex(/^ri\.magritte\.main\.source\.[0-9a-f-]{36}$/),
              name: z.string().optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Assembled worker credential set.",
        content: {
          "application/json": {
            schema: z.object({
              version: z.number().int(),
              fields: z.object({
                user: z.string(),
                password: z.string(),
                serverCaPem: z.string().optional(),
                clientCertPem: z.string().optional(),
                clientKeyPem: z.string().optional(),
              }),
            }),
          },
        },
      },
      403: { description: "Workload token invalid.", content: ErrorContent },
      404: { description: "Credential not found.", content: ErrorContent },
    },
  });

  // --- discovery -----------------------------------------------------------
  for (const [seg, summ] of [
    ["catalog", "List the source's catalog (databases/schemas)."],
    ["schemas", "List schemas in the source."],
    ["tables", "List tables in a schema."],
    ["columns", "List columns of a table."],
    ["primary-keys", "List primary-key columns of a table."],
    ["imported-keys", "List imported (foreign-key) relationships of a table."],
    ["preview", "Preview rows of a table."],
  ] as const) {
    registry.registerPath({
      method: "get",
      path: `/api/v1/connectivity/connections/{rid}/discovery/${seg}`,
      summary: summ,
      tags: ["connectivity"],
      security: ReadScope,
      request: {
        params: z.object({ rid: ConnectionRid }),
        query: z.record(z.string(), z.string()).optional(),
      },
      responses: {
        200: { description: "Discovery result.", content: { "application/json": { schema: z.unknown() } } },
        404: { description: "Not found.", content: ErrorContent },
      },
    });
  }

  // --- imports -------------------------------------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/connections/{rid}/imports",
    summary: "List table imports for a connection.",
    tags: ["connectivity"],
    security: ReadScope,
    request: {
      params: z.object({ rid: ConnectionRid }),
      query: z.object({ pageSize: z.coerce.number().int().min(1).max(200).optional(), pageToken: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Page of imports.",
        content: { "application/json": { schema: z.object({ data: z.array(TableImport), nextPageToken: z.string().optional() }) } },
      },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/connections/{rid}/snapshots",
    summary: "List snapshot imports for a connection.",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ rid: ConnectionRid }) },
    responses: {
      200: {
        description: "Snapshots.",
        content: { "application/json": { schema: z.object({ data: z.array(TableImport) }) } },
      },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/imports",
    summary: "Create a table import for a connection.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ rid: ConnectionRid }),
      headers: IdemHeader,
      body: { content: { "application/json": { schema: TableImportCreateRequest } }, required: true },
    },
    responses: {
      201: { description: "Created.", content: { "application/json": { schema: TableImport } } },
      400: { description: "Invalid.", content: ErrorContent },
      404: { description: "Connection not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/imports/{importRid}",
    summary: "Get a table import.",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ importRid: TableImportRidParam }) },
    responses: {
      200: { description: "Import.", content: { "application/json": { schema: TableImport } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "put",
    path: "/api/v1/connectivity/imports/{importRid}",
    summary: "Update a table import.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ importRid: TableImportRidParam }),
      headers: IfMatchHeader,
      body: { content: { "application/json": { schema: TableImportUpdateRequest } }, required: true },
    },
    responses: {
      200: { description: "Updated.", content: { "application/json": { schema: TableImport } } },
      404: { description: "Not found.", content: ErrorContent },
      412: { description: "If-Match missing/mismatch.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/v1/connectivity/imports/{importRid}",
    summary: "Delete a table import.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ importRid: TableImportRidParam }),
      headers: IfMatchHeader,
    },
    responses: {
      204: { description: "Deleted." },
      404: { description: "Not found.", content: ErrorContent },
      412: { description: "If-Match missing/mismatch.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/imports/{importRid}/execute",
    summary: "Execute a table import (enqueue a build).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ importRid: TableImportRidParam }),
      headers: IdemHeader,
    },
    responses: {
      202: { description: "Build enqueued.", content: { "application/json": { schema: z.unknown() } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/imports/execute-batch",
    summary: "Execute N imports as a single build (multi-table run).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      headers: IdemHeader,
      body: { content: { "application/json": { schema: z.object({ importRids: z.array(TableImportRidParam).min(1).max(500) }) } }, required: true },
    },
    responses: {
      202: { description: "Build enqueued.", content: { "application/json": { schema: z.unknown() } } },
      400: { description: "Invalid.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/imports/{importRid}/builds",
    summary: "List builds for a table import.",
    tags: ["connectivity"],
    security: ReadScope,
    request: {
      params: z.object({ importRid: TableImportRidParam }),
      query: z.object({ pageSize: z.coerce.number().int().min(1).max(200).optional(), pageToken: z.string().optional() }),
    },
    responses: {
      200: { description: "Builds.", content: { "application/json": { schema: z.object({ data: z.array(z.unknown()), nextPageToken: z.string().optional() }) } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });

  // --- builds --------------------------------------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/builds/{buildRid}",
    summary: "Get a single build (status, timings, counts, event log).",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ buildRid: BuildRidParam }) },
    responses: {
      200: { description: "Build.", content: { "application/json": { schema: z.unknown() } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/builds/{buildRid}/events",
    summary: "Stream build progress over Server-Sent Events (Redis pub/sub).",
    tags: ["connectivity"],
    security: ReadScope,
    request: {
      params: z.object({ buildRid: BuildRidParam }),
      headers: z.object({ "Last-Event-ID": z.string().optional() }),
    },
    responses: {
      200: {
        description: "SSE stream of build events.",
        content: { "text/event-stream": { schema: z.unknown() } },
      },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/builds/{buildRid}/cancel",
    summary: "Cancel an in-flight or queued build.",
    tags: ["connectivity"],
    security: WriteScope,
    request: { params: z.object({ buildRid: BuildRidParam }) },
    responses: {
      202: { description: "Cancellation requested.", content: { "application/json": { schema: z.unknown() } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });

  // --- cdc -----------------------------------------------------------------
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/cdc/preflight",
    summary: "Run CDC preflight checks (slot, publication, permissions).",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ rid: ConnectionRid }) },
    responses: {
      200: { description: "Preflight result.", content: { "application/json": { schema: PreflightResult } } },
      404: { description: "Connection not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/cdc/streams",
    summary: "Create a CDC stream (stores a table_imports row with mode=cdc).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ rid: ConnectionRid }),
      headers: IdemHeader,
      body: { content: { "application/json": { schema: CdcImportCreateRequest } }, required: true },
    },
    responses: {
      201: { description: "CDC stream created.", content: { "application/json": { schema: TableImport } } },
      400: { description: "Invalid.", content: ErrorContent },
      404: { description: "Connection not found.", content: ErrorContent },
    },
  });

  // --- virtual-tables ------------------------------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/connections/{rid}/virtual-tables",
    summary: "List virtual tables for a connection.",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ rid: ConnectionRid }) },
    responses: {
      200: { description: "Virtual tables.", content: { "application/json": { schema: z.object({ data: z.array(VirtualTable) }) } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/virtual-tables",
    summary: "Create a virtual table (federates a remote table as a dataset).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ rid: ConnectionRid }),
      headers: IdemHeader,
      body: { content: { "application/json": { schema: VirtualTableCreateRequest } }, required: true },
    },
    responses: {
      201: { description: "Created.", content: { "application/json": { schema: VirtualTable } } },
      400: { description: "Invalid.", content: ErrorContent },
      404: { description: "Connection not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/virtual-tables/{vrid}",
    summary: "Get a virtual table.",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ vrid: VirtualTableRidParam }) },
    responses: {
      200: { description: "Virtual table.", content: { "application/json": { schema: VirtualTable } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/v1/connectivity/virtual-tables/{vrid}",
    summary: "Delete a virtual table.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ vrid: VirtualTableRidParam }),
      headers: IfMatchHeader,
    },
    responses: {
      204: { description: "Deleted." },
      404: { description: "Not found.", content: ErrorContent },
      412: { description: "If-Match missing/mismatch.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/virtual-tables/{vrid}/refreshSchema",
    summary: "Refresh a virtual table's discovered schema.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ vrid: VirtualTableRidParam }),
      headers: IdemHeader,
    },
    responses: {
      200: { description: "Refreshed.", content: { "application/json": { schema: VirtualTable } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });

  // --- webhooks ------------------------------------------------------------
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/connections/{rid}/webhooks",
    summary: "List webhooks for a connection.",
    tags: ["connectivity"],
    security: ReadScope,
    request: {
      params: z.object({ rid: ConnectionRid }),
      query: z.object({ pageSize: z.coerce.number().int().min(1).max(200).optional(), pageToken: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Webhooks.",
        content: { "application/json": { schema: z.object({ data: z.array(WebhookResponse), nextPageToken: z.string().optional() }) } },
      },
      404: { description: "Connection not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/connections/{rid}/webhooks",
    summary: "Create a source-scoped webhook.",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ rid: ConnectionRid }),
      headers: IdemHeader,
      body: { content: { "application/json": { schema: WebhookCreateRequest } }, required: true },
    },
    responses: {
      201: { description: "Created.", content: { "application/json": { schema: WebhookResponse } } },
      400: { description: "Invalid.", content: ErrorContent },
      404: { description: "Connection not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/webhooks/{webhookRid}",
    summary: "Get a webhook.",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ webhookRid: WebhookRid }) },
    responses: {
      200: { description: "Webhook.", content: { "application/json": { schema: WebhookResponse } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/webhooks/{webhookRid}/versions",
    summary: "List immutable version history for a webhook.",
    tags: ["connectivity"],
    security: ReadScope,
    request: {
      params: z.object({ webhookRid: WebhookRid }),
      query: z.object({ pageSize: z.coerce.number().int().min(1).max(200).optional(), pageToken: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Versions.",
        content: { "application/json": { schema: z.object({ data: z.array(z.unknown()), nextPageToken: z.string().optional() }) } },
      },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "put",
    path: "/api/v1/connectivity/webhooks/{webhookRid}",
    summary: "Update a webhook (bumps a new immutable version).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ webhookRid: WebhookRid }),
      headers: IfMatchHeader,
      body: { content: { "application/json": { schema: WebhookUpdateRequest } }, required: true },
    },
    responses: {
      200: { description: "Updated.", content: { "application/json": { schema: WebhookResponse } } },
      404: { description: "Not found.", content: ErrorContent },
      412: { description: "If-Match missing/mismatch.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/webhooks/{webhookRid}/ready",
    summary: "Transition a webhook to the ready state.",
    tags: ["connectivity"],
    security: WriteScope,
    request: { params: z.object({ webhookRid: WebhookRid }) },
    responses: {
      200: { description: "Ready.", content: { "application/json": { schema: WebhookResponse } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/webhooks/{webhookRid}/activate",
    summary: "Activate a webhook (enables production execution).",
    tags: ["connectivity"],
    security: WriteScope,
    request: { params: z.object({ webhookRid: WebhookRid }) },
    responses: {
      200: { description: "Activated.", content: { "application/json": { schema: WebhookResponse } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/webhooks/{webhookRid}/disable",
    summary: "Disable a webhook.",
    tags: ["connectivity"],
    security: WriteScope,
    request: { params: z.object({ webhookRid: WebhookRid }) },
    responses: {
      200: { description: "Disabled.", content: { "application/json": { schema: WebhookResponse } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/api/v1/connectivity/webhooks/{webhookRid}",
    summary: "Archive a webhook.",
    tags: ["connectivity"],
    security: WriteScope,
    request: { params: z.object({ webhookRid: WebhookRid }) },
    responses: {
      204: { description: "Archived." },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/webhooks/{webhookRid}/test",
    summary: "Execute a webhook as a test (no external mutation guarantees).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ webhookRid: WebhookRid }),
      headers: IdemHeader,
      body: { content: { "application/json": { schema: WebhookExecuteRequest } } },
    },
    responses: {
      200: { description: "Execution summary.", content: { "application/json": { schema: WebhookExecutionResponse } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/api/v1/connectivity/webhooks/{webhookRid}/execute",
    summary: "Execute a webhook in production (active webhooks only).",
    tags: ["connectivity"],
    security: WriteScope,
    request: {
      params: z.object({ webhookRid: WebhookRid }),
      headers: IdemHeader,
      body: { content: { "application/json": { schema: WebhookExecuteRequest } } },
    },
    responses: {
      200: { description: "Execution summary.", content: { "application/json": { schema: WebhookExecutionResponse } } },
      404: { description: "Not found.", content: ErrorContent },
      409: { description: "Webhook not active.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/webhooks/{webhookRid}/executions",
    summary: "List executions for a webhook.",
    tags: ["connectivity"],
    security: ReadScope,
    request: {
      params: z.object({ webhookRid: WebhookRid }),
      query: z.object({ pageSize: z.coerce.number().int().min(1).max(500).optional(), pageToken: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Executions.",
        content: { "application/json": { schema: z.object({ data: z.array(WebhookExecutionResponse), nextPageToken: z.string().optional() }) } },
      },
      404: { description: "Not found.", content: ErrorContent },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/api/v1/connectivity/webhook-executions/{executionRid}",
    summary: "Get a single webhook execution.",
    tags: ["connectivity"],
    security: ReadScope,
    request: { params: z.object({ executionRid: WebhookExecutionRidParam }) },
    responses: {
      200: { description: "Execution.", content: { "application/json": { schema: WebhookExecutionResponse } } },
      404: { description: "Not found.", content: ErrorContent },
    },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Tellus Connectivity API",
      version: "0.1.0-b1",
      description:
        "Connections, credentials (B2), table imports (B5), virtual tables (B8), " +
        "and CDC (B7) surfaces for Tellus PostgreSQL Connectivity. Generated from " +
        "Zod contracts; do not hand-edit. Regenerate via " +
        "`npm run generate:openapi:connectivity`.",
      contact: { name: "Tellus Platform" },
      license: { name: "Apache-2.0" },
    },
    servers: [
      { url: "https://{tenant}.tellus.local", variables: { tenant: { default: "default" } } },
      { url: "http://localhost:3000" },
    ],
    tags: [
      {
        name: "connectivity",
        description: "Magritte-equivalent surface for PG connectivity.",
      },
    ],
  });
}

/** Stable JSON-shaped result for use in tests that diff against a snapshot. */
export function buildOpenApiJsonString(): string {
  return JSON.stringify(buildOpenApiDocument(), null, 2);
}
