// ---------------------------------------------------------------------------
// Connectivity (Magritte) error catalog.
// Spec §54 names this file. Errors covered span B1–B8 as the connectivity
// surface is shared; per-task additions append here.
// ---------------------------------------------------------------------------

import { def, register } from "./registry";

// B1 — connections CRUD + Compass binding ------------------------------------

export const ConnectorNotSupported = register(
  def(
    "Tellus:Connectivity:ConnectorNotSupported",
    "INVALID_ARGUMENT",
    "The requested connector_type is not implemented by this Tellus instance.",
  ),
);

export const ConnectionNameInvalid = register(
  def(
    "Tellus:Connectivity:ConnectionNameInvalid",
    "INVALID_ARGUMENT",
    "Connection name violates the connectivity naming convention.",
  ),
);

export const ConnectionNotFound = register(
  def(
    "Tellus:Connectivity:ConnectionNotFound",
    "NOT_FOUND",
    "No connection exists at the requested RID (or it has been soft-deleted).",
  ),
);

export const ResourceVersionMismatch = register(
  def(
    "Tellus:Connectivity:ResourceVersionMismatch",
    "CONFLICT",
    "If-Match header version did not match current resource version; reload and retry.",
  ),
);

export const IfMatchRequired = register(
  def(
    "Tellus:Connectivity:IfMatchRequired",
    "FAILED_PRECONDITION",
    "Mutating endpoints require an If-Match header carrying the current ETag.",
  ),
);

export const CompassFolderNotFound = register(
  def(
    "Tellus:Connectivity:CompassFolderNotFound",
    "NOT_FOUND",
    "The compass_folder_rid does not resolve to an existing Compass folder.",
  ),
);

export const CompassFolderPermissionDenied = register(
  def(
    "Tellus:Connectivity:CompassFolderPermissionDenied",
    "PERMISSION_DENIED",
    "Caller lacks 'compass:write' on the target Compass folder.",
  ),
);

export const ConnectionNameAlreadyExists = register(
  def(
    "Tellus:Connectivity:ConnectionNameAlreadyExists",
    "CONFLICT",
    "Another connection with the same name already exists in the target folder.",
  ),
);

export const HasActiveDependencies = register(
  def(
    "Tellus:Connectivity:HasActiveDependencies",
    "FAILED_PRECONDITION",
    "Cannot delete: active TableImports or VirtualTables reference this connection.",
  ),
);

export const AgentGroupRequired = register(
  def(
    "Tellus:Connectivity:AgentGroupRequired",
    "INVALID_ARGUMENT",
    "worker_type=agentProxy requires agent_group_rid to be set.",
  ),
);

export const AgentWorkerRejected = register(
  def(
    "Tellus:Connectivity:AgentWorkerRejected",
    "INVALID_ARGUMENT",
    "Legacy worker_type=agentWorker is no longer supported; use agentProxy.",
  ),
);

export const InvalidConfiguration = register(
  def(
    "Tellus:Connectivity:InvalidConfiguration",
    "INVALID_ARGUMENT",
    "The connection config failed schema validation for its connector_type.",
  ),
);

export const ScopeRequired = register(
  def(
    "Tellus:Connectivity:ScopeRequired",
    "PERMISSION_DENIED",
    "Caller's Multipass token lacks the required scope for this endpoint.",
  ),
);

// B2 — credentials -----------------------------------------------------------

export const CredentialDecryptionFailed = register(
  def(
    "Tellus:Connectivity:CredentialDecryptionFailed",
    "INTERNAL",
    "AES-GCM tag verification or KMS unwrap failed; ciphertext rejected.",
  ),
);

export const CredentialNotFound = register(
  def(
    "Tellus:Connectivity:CredentialNotFound",
    "NOT_FOUND",
    "No credential is associated with the requested connection RID.",
  ),
);

export const KmsUnavailable = register(
  def(
    "Tellus:Connectivity:KmsUnavailable",
    "UNAVAILABLE",
    "KMS backend reported unavailable; retry with backoff.",
  ),
);

// B3 — PostgreSQL adapter ----------------------------------------------------

export const JdbcAuthFailed = register(
  def(
    "Tellus:Connectivity:JdbcAuthFailed",
    "UNAUTHENTICATED",
    "PostgreSQL server rejected supplied credentials.",
  ),
);

export const JdbcHostUnreachable = register(
  def(
    "Tellus:Connectivity:JdbcHostUnreachable",
    "UNAVAILABLE",
    "PostgreSQL host did not accept the TCP connection within the configured timeout.",
  ),
);

export const JdbcTlsHandshakeFailed = register(
  def(
    "Tellus:Connectivity:JdbcTlsHandshakeFailed",
    "FAILED_PRECONDITION",
    "TLS handshake failed under the requested verify mode (verify-full / verify-ca).",
  ),
);

export const DiscoveryFailed = register(
  def(
    "Tellus:Connectivity:DiscoveryFailed",
    "INTERNAL",
    "information_schema or pg_catalog query failed during schema discovery.",
  ),
);

export const JdbcConnectFailed = register(
  def(
    "Tellus:Connectivity:JdbcConnectFailed",
    "UNAVAILABLE",
    "PostgreSQL connection attempt failed (network, TLS, DNS, or timeout); see classified reason.",
    502,
  ),
);

export const DriverMismatch = register(
  def(
    "Tellus:Connectivity:DriverMismatch",
    "INVALID_ARGUMENT",
    "Endpoint is connector-specific; the connection's driver does not match (e.g. PG endpoint on non-PG connection).",
  ),
);

export const DiscoveryArgumentMissing = register(
  def(
    "Tellus:Connectivity:DiscoveryArgumentMissing",
    "INVALID_ARGUMENT",
    "Required query parameters (schema, table) were not supplied to a discovery endpoint.",
  ),
);

export const DiscoveryCursorInvalid = register(
  def(
    "Tellus:Connectivity:DiscoveryCursorInvalid",
    "INVALID_ARGUMENT",
    "Pagination cursor failed base64url/JSON decode or missing schema/table fields.",
  ),
);

// Network egress -------------------------------------------------------------

export const EgressBlocked = register(
  def(
    "Tellus:Connectivity:EgressBlocked",
    "PERMISSION_DENIED",
    "The connection's target host:port is not permitted by its network egress allowlist.",
    403,
  ),
);

export const EgressRateLimited = register(
  def(
    "Tellus:Connectivity:EgressRateLimited",
    "RESOURCE_EXHAUSTED",
    "Too many connection-test attempts; retry after the indicated cooldown.",
    429,
  ),
);

// Named egress policy resource ----------------------------------------------

export const EgressPolicyNotFound = register(
  def(
    "Tellus:Connectivity:EgressPolicyNotFound",
    "NOT_FOUND",
    "The referenced egress policy RID does not resolve to an existing policy.",
  ),
);

export const EgressPolicyNotApproved = register(
  def(
    "Tellus:Connectivity:EgressPolicyNotApproved",
    "PERMISSION_DENIED",
    "The referenced egress policy is not in APPROVED status and cannot be used.",
  ),
);

// Agent proxy dispatch -------------------------------------------------------

export const AgentUnavailable = register(
  def(
    "Tellus:Connectivity:AgentUnavailable",
    "UNAVAILABLE",
    "worker_type=agentProxy but no agent group is registered for the connection's agent_group_rid.",
    502,
  ),
);

// Credential rotation --------------------------------------------------------

export const CredentialRotationFailed = register(
  def(
    "Tellus:Connectivity:CredentialRotationFailed",
    "INTERNAL",
    "Failed to write a new credential version during rotation; the previous version remains active.",
  ),
);
