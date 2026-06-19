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
  EgressPolicy,
  ErrorEnvelopeSchema,
  PostgresConfig,
  TableImport,
  TlsMode,
  VirtualTable,
  WorkerType,
} from "./contracts";

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
