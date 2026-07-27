// ---------------------------------------------------------------------------
// Connectivity Zod contracts (Conjure-equivalent IDL surface).
// Spec §43: Connection, TableImport, VirtualTable, Driver.
// Inferred TS types are the single source of truth for handler signatures
// and for OpenAPI emission (src/services/connectivity/openapi.ts).
// ---------------------------------------------------------------------------

import { z } from "zod";

// --- shared primitives ------------------------------------------------------

/** ri.magritte.main.source.<uuid> */
export const ConnectionRid = z
  .string()
  .regex(
    /^ri\.magritte\.main\.source\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "ConnectionRid must match ri.magritte.main.source.<uuid>",
  )
  .brand<"ConnectionRid">();
export type ConnectionRid = z.infer<typeof ConnectionRid>;

/** ri.magritte.main.extract.<uuid> */
export const TableImportRid = z
  .string()
  .regex(
    /^ri\.magritte\.main\.extract\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "TableImportRid must match ri.magritte.main.extract.<uuid>",
  )
  .brand<"TableImportRid">();
export type TableImportRid = z.infer<typeof TableImportRid>;

/** ri.foundry.main.dataset.<uuid> */
export const DatasetRid = z
  .string()
  .regex(
    /^ri\.foundry\.main\.dataset\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "DatasetRid must match ri.foundry.main.dataset.<uuid>",
  )
  .brand<"DatasetRid">();
export type DatasetRid = z.infer<typeof DatasetRid>;

/**
 * RID of the Compass container a connection (source) is parented under.
 *
 * The folder picker can return any container namespace — `project`, `space`, or
 * folder (`folder` / `compass-folder`) — so this brand accepts all of them, not
 * just `ri.compass.main.folder.*`. Restricting it to `folder` previously forced
 * the wizard to discard the user's selected location and substitute a default.
 * (Name kept for back-compat; semantically this is a "compass parent container
 * rid".)
 */
export const CompassFolderRid = z
  .string()
  .regex(
    /^ri\.compass\.main\.(?:compass-folder|folder|project|space)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "must be a Compass container RID (folder, project, or space)",
  )
  .brand<"CompassFolderRid">();
export type CompassFolderRid = z.infer<typeof CompassFolderRid>;

/** ri.magritte.main.agent-group.<uuid> */
export const AgentGroupRid = z
  .string()
  .regex(/^ri\.magritte\.main\.agent-group\.[0-9a-f-]{36}$/)
  .brand<"AgentGroupRid">();
export type AgentGroupRid = z.infer<typeof AgentGroupRid>;

export const ConnectorType = z.enum(["postgresql", "rest-api"]);
export type ConnectorType = z.infer<typeof ConnectorType>;

export const WorkerType = z.enum(["foundryWorker", "agentProxy"]);
export type WorkerType = z.infer<typeof WorkerType>;

export const TlsMode = z.enum(["disable", "require", "verify-ca", "verify-full"]);
export type TlsMode = z.infer<typeof TlsMode>;

export const ConnectionStatusState = z.enum([
  "UNKNOWN",
  "HEALTHY",
  "DEGRADED",
  "UNREACHABLE",
  "AUTH_FAILED",
  "TLS_FAILED",
]);
export type ConnectionStatusState = z.infer<typeof ConnectionStatusState>;

// --- connector-specific config ---------------------------------------------

export const PostgresConfig = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1).max(63),
  /** SQL role; secret material (password / certs) is in the credential vault. */
  user: z.string().min(1).max(63).default("tellus"),
  applicationName: z.string().min(1).max(64).default("tellus-magritte"),
  tlsMode: TlsMode.default("verify-full"),
  /** PEM-encoded server CA used when tlsMode requires verification. */
  serverCaPem: z.string().optional(),
  /** Client cert for mTLS, optional. */
  clientCertPem: z.string().optional(),
  /** Client key for mTLS, optional. Stored encrypted in the credential vault. */
  clientKeyEncrypted: z.boolean().default(false),
  connectTimeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  socketTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
  /** Max pg.Pool connections; default 4 — safe for hundreds of dormant tenants. */
  poolMax: z.number().int().min(1).max(64).default(4),
  /** Additional `application_name`-style query params; constrained set. */
  extraParams: z.record(z.string(), z.string()).default({}),
});
export type PostgresConfig = z.infer<typeof PostgresConfig>;

export const RestApiAuthentication = z.enum(["none", "basic", "bearer"]);
export type RestApiAuthentication = z.infer<typeof RestApiAuthentication>;

export const RestApiDomainConfig = z.object({
  baseUrl: z
    .string()
    .url()
    .max(2048)
    .refine((value) => new URL(value).protocol === "https:", {
      message: "REST API domains must use HTTPS",
    }),
  port: z.number().int().min(1).max(65535).default(443),
  authentication: RestApiAuthentication.default("none"),
});
export type RestApiDomainConfig = z.infer<typeof RestApiDomainConfig>;

const RestApiSecretName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/);

export const RestApiConfig = z
  .object({
    domains: z.array(RestApiDomainConfig).min(1).max(100),
    additionalSecretNames: z.array(RestApiSecretName).max(100).default([]),
    apiName: z
      .string()
      .regex(/^[A-Z][A-Za-z0-9]{0,99}$/)
      .nullable()
      .optional(),
  })
  .superRefine((value, ctx) => {
    const domainKeys = value.domains.map((domain) => {
      const url = new URL(domain.baseUrl);
      return `${url.hostname.toLowerCase()}:${domain.port}${url.pathname}`;
    });
    if (new Set(domainKeys).size !== domainKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["domains"],
        message: "REST API domains must be unique",
      });
    }
    if (
      new Set(value.additionalSecretNames).size !==
      value.additionalSecretNames.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["additionalSecretNames"],
        message: "REST API additional secret names must be unique",
      });
    }
  });
export type RestApiConfig = z.infer<typeof RestApiConfig>;

export const ConnectionConfig = z.discriminatedUnion("connectorType", [
  z.object({ connectorType: z.literal("postgresql"), postgres: PostgresConfig }),
  z.object({ connectorType: z.literal("rest-api"), restApi: RestApiConfig }),
]);
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

// --- egress policy ----------------------------------------------------------

export const EgressEntry = z.union([
  z.object({ kind: z.literal("host"), host: z.string().min(1), port: z.number().int().min(1).max(65535) }),
  z.object({ kind: z.literal("cidr"), cidr: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/), port: z.number().int().min(1).max(65535) }),
]);
export type EgressEntry = z.infer<typeof EgressEntry>;
export const EgressPolicy = z.object({
  allowlist: z.array(EgressEntry).min(1),
});
export type EgressPolicy = z.infer<typeof EgressPolicy>;

// --- named egress policy resource ------------------------------------------

/** ri.magritte.main.egress-policy.<uuid> */
export const EgressPolicyRid = z
  .string()
  .regex(
    /^ri\.magritte\.main\.egress-policy\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "EgressPolicyRid must match ri.magritte.main.egress-policy.<uuid>",
  )
  .brand<"EgressPolicyRid">();
export type EgressPolicyRid = z.infer<typeof EgressPolicyRid>;

/**
 * Approval workflow status. A named policy is only enforceable once APPROVED;
 * PENDING policies exist but cannot gate live traffic, and REJECTED policies
 * are terminal. Mirrors the DB CHECK constraint (migration 088).
 */
export const EgressPolicyStatus = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export type EgressPolicyStatus = z.infer<typeof EgressPolicyStatus>;

/** A reusable, named, approvable egress allowlist referenced by connections. */
export const NamedEgressPolicy = z.object({
  rid: EgressPolicyRid,
  tenant: z.string().min(1),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_\-\.]{0,127}$/),
  description: z.string().max(2000).default(""),
  status: EgressPolicyStatus,
  allowlist: z.array(EgressEntry).min(1),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  createdBy: z.string(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string(),
  approvedAt: z.string().datetime().nullable(),
  approvedBy: z.string().nullable(),
});
export type NamedEgressPolicy = z.infer<typeof NamedEgressPolicy>;

export const EgressPolicyCreateRequest = z.object({
  name: NamedEgressPolicy.shape.name,
  description: NamedEgressPolicy.shape.description.optional(),
  allowlist: z.array(EgressEntry).min(1),
});
export type EgressPolicyCreateRequest = z.infer<typeof EgressPolicyCreateRequest>;

export const EgressPolicyUpdateRequest = z.object({
  name: NamedEgressPolicy.shape.name.optional(),
  description: NamedEgressPolicy.shape.description.optional(),
  allowlist: z.array(EgressEntry).min(1).optional(),
});
export type EgressPolicyUpdateRequest = z.infer<typeof EgressPolicyUpdateRequest>;

/** Approve or reject a PENDING policy. */
export const EgressPolicyDecisionRequest = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
});
export type EgressPolicyDecisionRequest = z.infer<typeof EgressPolicyDecisionRequest>;

export const EgressPolicyListResponse = z.object({
  data: z.array(NamedEgressPolicy),
  nextPageToken: z.string().optional(),
});
export type EgressPolicyListResponse = z.infer<typeof EgressPolicyListResponse>;

// --- connection settings (governance: exports + code imports) --------------

/** Step 5 — export governance. */
export const ExportSettings = z.object({
  exportsEnabled: z.boolean().default(false),
  skipMarkingsValidation: z.boolean().default(false),
});
export type ExportSettings = z.infer<typeof ExportSettings>;

/**
 * Step 6 — code-import governance. `allowVirtualTables` is forced-on (a
 * platform rule that cannot be disabled, only governed by source access),
 * mirrored as a disabled toggle in the wizard UI.
 */
export const CodeImportSettings = z.object({
  allowCodeRepositories: z.boolean().default(false),
  allowComputeModules: z.boolean().default(false),
  allowPipelineUdfs: z.boolean().default(false),
  allowVirtualTables: z.boolean().default(true),
});
export type CodeImportSettings = z.infer<typeof CodeImportSettings>;

/** CDC defaults for this source — the transaction isolation level and any
 *  advanced Debezium property overrides edited on the "CDC syncs" tab. */
export const CdcSettings = z.object({
  isolationLevel: z
    .enum(["snapshot", "read_committed", "read_uncommitted", "repeatable_read", "serializable"])
    .default("snapshot"),
  debeziumProperties: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .default([]),
});
export type CdcSettings = z.infer<typeof CdcSettings>;

export const ConnectionSettings = z.object({
  export: ExportSettings.default({
    exportsEnabled: false,
    skipMarkingsValidation: false,
  }),
  codeImport: CodeImportSettings.default({
    allowCodeRepositories: false,
    allowComputeModules: false,
    allowPipelineUdfs: false,
    allowVirtualTables: true,
  }),
  /**
   * RID of the default output folder for syncs, set by the new-source wizard.
   * Persisted as a durable RID ONLY — the display name and path are resolved at
   * read time (GET /folders/:rid) so they never go stale if the folder is
   * renamed or moved. `compassFolderRid` is a strict-branded fallback that
   * cannot recover the user's selected output location, hence this explicit ref.
   */
  outputFolderRid: z
    .string()
    .regex(/^ri\.[a-z]/, "outputFolderRid must be a resource identifier (ri.…)")
    .nullable()
    .optional(),
  /** Source-level CDC defaults edited on the "CDC syncs" tab. */
  cdc: CdcSettings.optional(),
  /** Free-form labels shown on the source Overview. */
  tags: z.array(z.string()).optional(),
});
export type ConnectionSettings = z.infer<typeof ConnectionSettings>;

/** Canonical default used by the DB column default and repo read fallbacks. */
export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings =
  ConnectionSettings.parse({});

// --- Connection resource ---------------------------------------------------

export const ConnectionStatus = z.object({
  state: ConnectionStatusState,
  lastCheckedAt: z.string().datetime().nullable(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const Connection = z.object({
  rid: ConnectionRid,
  tenant: z.string().min(1),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z][a-zA-Z0-9_\-\.]{0,127}$/),
  description: z.string().max(2000).default(""),
  connectorType: ConnectorType,
  workerType: WorkerType,
  agentGroupRid: AgentGroupRid.optional(),
  config: ConnectionConfig,
  egressPolicy: EgressPolicy,
  /**
   * Optional reference to a named, approved egress policy. When set, the named
   * policy's allowlist is enforced at connection-open time (and the policy must
   * be APPROVED); when null, the inline `egressPolicy` allowlist is used.
   */
  egressPolicyRid: EgressPolicyRid.nullable().optional(),
  compassFolderRid: CompassFolderRid,
  status: ConnectionStatus,
  settings: ConnectionSettings.default({
    export: { exportsEnabled: false, skipMarkingsValidation: false },
    codeImport: {
      allowCodeRepositories: false,
      allowComputeModules: false,
      allowPipelineUdfs: false,
      allowVirtualTables: true,
    },
  }),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  createdBy: z.string(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string(),
  /**
   * Human-readable display names for `createdBy` / `updatedBy`, resolved from
   * the `users` table. Read-only enrichment populated ONLY by the list
   * endpoint (a single LEFT JOIN on `users`) so the list UI can render creator
   * / last-editor labels without a separate user-directory round-trip.
   *
   * `null` when the referenced user row no longer exists; absent on the
   * single-connection read paths (create / get / update) which do not join.
   * Never accepted on write — the create/update request schemas omit it.
   */
  createdByName: z.string().nullable().optional(),
  updatedByName: z.string().nullable().optional(),
});
export type Connection = z.infer<typeof Connection>;

// --- create / update payloads ---------------------------------------------

export const ConnectionCreateRequest = z.object({
  name: Connection.shape.name,
  description: Connection.shape.description.optional(),
  connectorType: ConnectorType,
  workerType: WorkerType,
  agentGroupRid: AgentGroupRid.optional(),
  config: ConnectionConfig,
  egressPolicy: EgressPolicy,
  /** Optional reference to a named, approved egress policy (see Connection). */
  egressPolicyRid: EgressPolicyRid.nullable().optional(),
  compassFolderRid: CompassFolderRid,
  settings: ConnectionSettings.optional(),
  /**
   * Inline mTLS client private key (PEM). Write-only: never stored in the
   * connection config — the handler persists it to the credential vault as the
   * `client_key` secret and sets config.postgres.clientKeyEncrypted instead.
   */
  clientKeyPem: z.string().min(1).max(64 * 1024).optional(),
}).superRefine((v, ctx) => {
  if (v.workerType === "agentProxy" && !v.agentGroupRid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agentGroupRid"],
      message: "agentGroupRid is required when workerType=agentProxy",
    });
  }
  if (v.config.connectorType !== v.connectorType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config", "connectorType"],
      message: "config.connectorType must match top-level connectorType",
    });
  }
  if (v.clientKeyPem && v.connectorType !== "postgresql") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["clientKeyPem"],
      message: "clientKeyPem is only supported for PostgreSQL connections",
    });
  }
});
export type ConnectionCreateRequest = z.infer<typeof ConnectionCreateRequest>;

export const ConnectionUpdateRequest = z.object({
  name: Connection.shape.name.optional(),
  description: Connection.shape.description.optional(),
  config: ConnectionConfig.optional(),
  egressPolicy: EgressPolicy.optional(),
  /** Re-point (or clear, via null) the named egress policy reference. */
  egressPolicyRid: EgressPolicyRid.nullable().optional(),
  agentGroupRid: AgentGroupRid.optional(),
  settings: ConnectionSettings.optional(),
  /** Inline mTLS client private key (PEM); persisted to the vault, see create. */
  clientKeyPem: z.string().min(1).max(64 * 1024).optional(),
});
export type ConnectionUpdateRequest = z.infer<typeof ConnectionUpdateRequest>;

export const ConnectionListResponse = z.object({
  data: z.array(Connection),
  nextPageToken: z.string().optional(),
});
export type ConnectionListResponse = z.infer<typeof ConnectionListResponse>;

// --- TableImport (B5 — surfaced here for OpenAPI completeness) ------------

export const TableImportMode = z.enum(["SNAPSHOT", "APPEND", "STREAMING_CHANGELOG"]);
export type TableImportMode = z.infer<typeof TableImportMode>;

export const TableImport = z.object({
  rid: TableImportRid,
  connectionRid: ConnectionRid,
  mode: TableImportMode,
  query: z.string(),
  incrementalColumn: z.string().optional(),
  outputDatasetRid: DatasetRid,
  schedule: z.string().optional(),
  allowSchemaChanges: z.boolean().default(false),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TableImport = z.infer<typeof TableImport>;

// --- VirtualTable (B8 — surfaced for OpenAPI completeness) ---------------

export const VirtualTableRid = z
  .string()
  .regex(/^ri\.magritte\.main\.virtual-table\.[0-9a-f-]{36}$/)
  .brand<"VirtualTableRid">();
export type VirtualTableRid = z.infer<typeof VirtualTableRid>;

export const VirtualTable = z.object({
  rid: VirtualTableRid,
  connectionRid: ConnectionRid,
  sourceSchema: z.string(),
  sourceTable: z.string(),
  exposedNamespace: z.string(),
  exposedName: z.string(),
  columnSchema: z.array(z.object({ name: z.string(), type: z.string() })),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VirtualTable = z.infer<typeof VirtualTable>;

// --- Driver (B3 — surfaced for OpenAPI completeness) --------------------

export const Driver = z.object({
  id: z.string(),
  connectorType: ConnectorType,
  version: z.string(),
  capabilities: z.object({
    snapshot: z.boolean(),
    append: z.boolean(),
    cdc: z.boolean(),
    virtualTables: z.boolean(),
  }),
});
export type Driver = z.infer<typeof Driver>;

// --- ConnectorTypeEntry (master registry for source picker) -----------------

export const ConnectorTypeCapabilities = z.object({
  batchSync: z.boolean(),
  cdcSync: z.boolean(),
  tableExport: z.boolean(),
  useInCode: z.boolean(),
});
export type ConnectorTypeCapabilities = z.infer<typeof ConnectorTypeCapabilities>;

export const ConnectorTypeBadge = z.enum(["BETA", "EXPERIMENTAL"]);
export type ConnectorTypeBadge = z.infer<typeof ConnectorTypeBadge>;

export const ConnectorTypeEntry = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
  iconColor: z.string(),
  iconSrc: z.string().nullable(),
  badge: ConnectorTypeBadge.nullable(),
  tags: z.array(z.string()),
  href: z.string().nullable(),
  connectorType: ConnectorType,
  capabilities: ConnectorTypeCapabilities,
  sortOrder: z.number().int(),
});
export type ConnectorTypeEntry = z.infer<typeof ConnectorTypeEntry>;

export const ConnectorTypeListResponse = z.object({
  data: z.array(ConnectorTypeEntry),
});
export type ConnectorTypeListResponse = z.infer<typeof ConnectorTypeListResponse>;

// --- envelope schema (Conjure error) ------------------------------------

export const ErrorEnvelopeSchema = z.object({
  errorCode: z.string(),
  errorName: z.string(),
  errorInstanceId: z.string().uuid(),
  parameters: z.record(z.string(), z.unknown()),
});
export type ErrorEnvelopeSchema = z.infer<typeof ErrorEnvelopeSchema>;
