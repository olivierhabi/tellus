// ---------------------------------------------------------------------------
// Connections handlers (B1, spec §62-70).
//
// 7 endpoints:
//   POST   /api/v2/connectivity/connections
//   GET    /api/v2/connectivity/connections/{rid}
//   GET    /api/v2/connectivity/connections
//   PUT    /api/v2/connectivity/connections/{rid}                  (If-Match)
//   DELETE /api/v2/connectivity/connections/{rid}                  (If-Match, soft delete)
//   GET    /api/v2/connectivity/connections/{rid}/configuration
//   GET    /api/v2/connectivity/connections/{rid}/status
//
// Cross-cutting (verified per agent prompt §9):
//   - Conjure envelope on all 4xx/5xx via TellusError.send / sendEnvelope.
//   - errorName matches Tellus:Connectivity:PascalCase (registry guard enforces).
//   - Idempotency-Key handled by src/middleware/idempotencyKey.ts mounted on POST.
//   - ETag emitted on read (weak: W/"<version>") via setConnectivityEtag.
//   - If-Match required on PUT/DELETE; mismatch → 409 ResourceVersionMismatch.
//   - RID format ri.magritte.main.source.<uuid>; minted via crypto.randomUUID.
//   - OTel span tags tellus.tenant/user/rid set on every handler.
//   - Latency histogram tellus_connectivity_request_duration_seconds.
//   - Scope check: 'connectivity:read' for GET; 'connectivity:write' for mutations.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { trace } from "@opentelemetry/api";
import { Counter, Histogram, register as metricsRegistry } from "prom-client";

import { withTransaction } from "../../../db";
import {
  AgentGroupRequired,
  AgentWorkerRejected,
  CompassFolderNotFound,
  ConnectionNameAlreadyExists,
  ConnectionNotFound,
  ConnectorNotSupported,
  HasActiveDependencies,
  InvalidConfiguration,
  ScopeRequired,
} from "../../../lib/errors/connectivity.errors";
import { TellusError, sendEnvelope } from "../../../lib/errors/envelope";
import {
  requireConnectivityIfMatch,
  setConnectivityEtag,
} from "../../../middleware/connectivityEtag";
import * as compassClient from "../clients/compass.client";
import * as vault from "../credentials/vault";
import {
  Connection,
  ConnectionCreateRequest,
  ConnectionRid,
  ConnectionUpdateRequest,
  PostgresConfig,
} from "../contracts";
import * as repo from "../store/connections.repo";
import * as outbox from "../store/outbox";

// --- Prometheus metrics -----------------------------------------------------

function getOrCreateHistogram(
  opts: ConstructorParameters<typeof Histogram>[0],
): Histogram<string> {
  const existing = metricsRegistry.getSingleMetric(opts.name);
  if (existing) return existing as Histogram<string>;
  return new Histogram(opts);
}

function getOrCreateCounter(
  opts: ConstructorParameters<typeof Counter>[0],
): Counter<string> {
  const existing = metricsRegistry.getSingleMetric(opts.name);
  if (existing) return existing as Counter<string>;
  return new Counter(opts);
}

const requestDuration = getOrCreateHistogram({
  name: "tellus_connectivity_request_duration_seconds",
  help: "Connectivity HTTP request latency.",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.4, 1, 2.5, 5],
  labelNames: ["route", "method", "status"] as const,
});

const errorsByName = getOrCreateCounter({
  name: "tellus_connectivity_errors_total",
  help: "Connectivity errors emitted, by registered errorName.",
  labelNames: ["errorName", "route"] as const,
});

// --- User-context extraction ------------------------------------------------

interface AuthenticatedUser {
  id: string; // uuid
  tenant: string;
  scopes: string[];
}

/** Keycloak realm role that grants platform superadmin. */
const TELLUS_SUPERADMIN_ROLE = "tellus-superadmin";

/** Every connectivity scope, granted wholesale to superadmins. */
const ALL_CONNECTIVITY_SCOPES = [
  "connectivity:read",
  "connectivity:write",
  "connectivity:test",
  "secrets:read",
  "secrets:write",
  "secrets:rotate",
  "ontology:read",
  "ontology:write",
] as const;

/**
 * Maps coarse Keycloak realm roles to the fine-grained connectivity scopes they
 * imply. This is the SERVER-SIDE authority; tellus-fe/lib/data-connection/
 * scopes.ts mirrors the same intent for UX gating only. Conservative by design:
 * each role grants only the scopes its job function needs (deny-by-default for
 * anything unmapped).
 */
const ROLE_SCOPE_GRANTS: Record<string, readonly string[]> = {
  [TELLUS_SUPERADMIN_ROLE]: ALL_CONNECTIVITY_SCOPES,
  "connectivity-admin": ALL_CONNECTIVITY_SCOPES,
  "connectivity-editor": [
    "connectivity:read",
    "connectivity:write",
    "connectivity:test",
    "secrets:read",
    "secrets:write",
  ],
  "connectivity-viewer": ["connectivity:read"],
  // Ontology editors bind object types to datasets/connections (B10), which
  // needs to read the connection catalogue plus ontology write.
  "ontology-editor": ["ontology:read", "ontology:write", "connectivity:read"],
  "ontology-viewer": ["ontology:read"],
};

/** Gathers realm roles from both `user.roles` and Keycloak `claims.realm_access.roles`. */
function collectRoles(u: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const direct = u.roles;
  if (Array.isArray(direct)) {
    for (const r of direct) if (typeof r === "string") out.add(r);
  }
  const claims = u.claims as Record<string, unknown> | undefined;
  const realmAccess = claims?.realm_access as { roles?: unknown } | undefined;
  if (Array.isArray(realmAccess?.roles)) {
    for (const r of realmAccess!.roles as unknown[]) {
      if (typeof r === "string") out.add(r);
    }
  }
  return [...out];
}

/**
 * Derives the effective connectivity scope set for a principal. Resolution:
 *   1) explicit `scopes`/`scope`/`permissions` claim (real Multipass / PAT) — honored verbatim;
 *   2) realm roles mapped via ROLE_SCOPE_GRANTS (Keycloak users carry no scope claim);
 *   3) scope-shaped roles (a realm role literally named e.g. "connectivity:read") — granted directly.
 * Deny-by-default: a principal with no explicit scope and no mapped role gets an empty set.
 */
function deriveScopes(u: Record<string, unknown>): string[] {
  const granted = new Set<string>();

  const scopesRaw = (u.scopes ?? u.scope ?? u.permissions ?? []) as
    | string[]
    | string
    | undefined;
  const explicit = Array.isArray(scopesRaw)
    ? scopesRaw
    : typeof scopesRaw === "string"
    ? scopesRaw.split(/\s+/).filter(Boolean)
    : [];
  for (const s of explicit) granted.add(s);

  for (const role of collectRoles(u)) {
    const mapped = ROLE_SCOPE_GRANTS[role];
    if (mapped) for (const s of mapped) granted.add(s);
    if (role.includes(":")) granted.add(role);
  }
  return [...granted];
}

/**
 * Pulls the user context off req — flexible to whatever shape `globalAuth`
 * deposits ({ id, email, roles, claims }). Falls back to req.session.user
 * then a Multipass token payload. Throws Tellus:Connectivity:ScopeRequired
 * if no candidate yields an id.
 */
export function extractUser(req: Request): AuthenticatedUser {
  const r = req as unknown as Record<string, unknown>;
  const candidates = [
    r.user,
    (r.session as Record<string, unknown> | undefined)?.user,
    r.tellusUser,
    r.multipassUser,
  ] as Array<Record<string, unknown> | undefined>;
  for (const u of candidates) {
    if (!u) continue;
    const id = (u.id ?? u.sub ?? u.userId) as string | undefined;
    if (!id) continue;
    const claims = u.claims as Record<string, unknown> | undefined;
    const tenant =
      ((u.tenant ??
        u.tenantId ??
        u.tenant_id ??
        claims?.tenant ??
        claims?.tenant_id) as string | undefined) ?? "default";
    return { id, tenant, scopes: deriveScopes(u) };
  }
  throw new TellusError(ScopeRequired, { reason: "no_user_context" });
}

export function requireScope(user: AuthenticatedUser, scope: string): void {
  if (!user.scopes.includes(scope) && !user.scopes.includes("connectivity:*")) {
    throw new TellusError(ScopeRequired, { required: scope });
  }
}

// --- timer + error wrap -----------------------------------------------------

function instrument(routeName: string, method: string) {
  return function decorate(
    handler: (req: Request, res: Response) => Promise<void>,
  ): (req: Request, res: Response, next: NextFunction) => Promise<void> {
    return async (req, res, next) => {
      const stop = requestDuration
        .labels({ route: routeName, method, status: "pending" })
        .startTimer();
      const span = trace.getActiveSpan();
      const user = (() => {
        try {
          return extractUser(req);
        } catch {
          return null;
        }
      })();
      if (span && user) {
        span.setAttribute("tellus.tenant", user.tenant);
        span.setAttribute("tellus.user", user.id);
      }
      if (span && req.params.rid) {
        span.setAttribute("tellus.rid", req.params.rid);
      }
      try {
        await handler(req, res);
        stop({ status: String(res.statusCode) });
      } catch (e) {
        const err =
          e instanceof TellusError
            ? e
            : new TellusError(
                {
                  errorCode: "INTERNAL",
                  errorName: "Tellus:Connectivity:Internal",
                  httpStatus: 500,
                  description: "Unhandled internal error.",
                },
                { cause: e instanceof Error ? e.message : String(e) },
              );
        errorsByName
          .labels({ errorName: err.definition.errorName, route: routeName })
          .inc();
        if (!res.headersSent) {
          err.send(res);
        }
        stop({ status: String(err.definition.httpStatus) });
        // Pass to error middleware for logging only (response already sent).
        next(undefined);
      }
    };
  };
}

// --- RID minting ------------------------------------------------------------

function mintConnectionRid(): string {
  return `ri.magritte.main.source.${randomUUID()}`;
}

// --- handlers ---------------------------------------------------------------

export const postConnection = instrument("/api/v2/connectivity/connections", "POST")(
  async (req, res) => {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");

    const parsed = ConnectionCreateRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new TellusError(InvalidConfiguration, {
        issues: parsed.error.issues,
      });
    }
    const request = parsed.data;

    if (request.connectorType !== "postgresql") {
      throw new TellusError(ConnectorNotSupported, {
        connectorType: request.connectorType,
      });
    }
    if (request.workerType === "agentProxy" && !request.agentGroupRid) {
      throw new TellusError(AgentGroupRequired, {});
    }
    // Reject removed agentWorker even though Zod enum should catch it.
    if ((request.workerType as string) === "agentWorker") {
      throw new TellusError(AgentWorkerRejected, {});
    }
    if (request.connectorType === "postgresql") {
      const cfg = PostgresConfig.safeParse(request.config.postgres);
      if (!cfg.success) {
        throw new TellusError(InvalidConfiguration, {
          issues: cfg.error.issues,
        });
      }
    }

    const folder = await compassClient.getFolder(request.compassFolderRid);
    await compassClient.assertWritePermission(folder.rid, user.id);

    const dup = await repo.findByNameInFolder(
      user.tenant,
      request.compassFolderRid,
      request.name,
    );
    if (dup) {
      throw new TellusError(ConnectionNameAlreadyExists, {
        folderRid: request.compassFolderRid,
        name: request.name,
      });
    }

    const rid = mintConnectionRid();

    // mTLS private key is secret material: persist it to the credential vault
    // (never stored in plaintext config) and flip clientKeyEncrypted so the
    // pool layer unwraps it. Stored before the insert so a connection is never
    // recorded as having an encrypted key without the key actually existing.
    if (request.clientKeyPem && request.config.connectorType === "postgresql") {
      const keyBytes = Buffer.from(request.clientKeyPem, "utf8");
      await vault.createOrRotate(
        rid,
        user.tenant,
        "client_key",
        new Uint8Array(keyBytes),
        user.id,
      );
      keyBytes.fill(0);
      request.config.postgres.clientKeyEncrypted = true;
    }

    const created = await withTransaction(async (client) => {
      const conn = await repo.insert(client, {
        rid,
        tenant: user.tenant,
        request,
        actor: user.id,
      });
      await outbox.enqueue(client, {
        connectionRid: rid,
        folderRid: request.compassFolderRid,
        operation: "registerResource",
        payload: {
          displayName: conn.name,
          description: conn.description ?? "",
          spaceRid: folder.spaceRid,
          createdBy: user.id,
          metadata: {
            connectorType: conn.connectorType,
            workerType: conn.workerType,
            agentGroupRid: conn.agentGroupRid ?? null,
          },
        },
      });
      return conn;
    });

    setConnectivityEtag(res, created.version);
    res.setHeader("Location", `/api/v2/connectivity/connections/${rid}`);
    res.status(201).json(created);
  },
);

export const getConnection = instrument(
  "/api/v2/connectivity/connections/:rid",
  "GET",
)(async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:read");
  const conn = await repo.findByRid(req.params.rid, user.tenant);
  setConnectivityEtag(res, conn.version);
  res.status(200).json(conn);
});

export const listConnections = instrument(
  "/api/v2/connectivity/connections",
  "GET",
)(async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:read");
  const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
    throw new TellusError(InvalidConfiguration, {
      field: "pageSize",
      message: "must be a positive integer",
    });
  }
  const result = await repo.list({
    tenant: user.tenant,
    folderRid: req.query.folderRid as string | undefined,
    connectorType: req.query.connectorType as string | undefined,
    pageSize,
    pageToken: (req.query.pageToken as string | undefined) ?? null,
  });
  res.status(200).json(result);
});

export const putConnection = instrument(
  "/api/v2/connectivity/connections/:rid",
  "PUT",
)(async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:write");

  const current = await repo.findByRid(req.params.rid, user.tenant);
  const expected = requireConnectivityIfMatch(req, current.version);

  const parsed = ConnectionUpdateRequest.safeParse(req.body);
  if (!parsed.success) {
    throw new TellusError(InvalidConfiguration, {
      issues: parsed.error.issues,
    });
  }
  const patch = parsed.data;

  if (patch.name && patch.name !== current.name) {
    const dup = await repo.findByNameInFolder(
      user.tenant,
      current.compassFolderRid,
      patch.name,
    );
    if (dup && dup.rid !== current.rid) {
      throw new TellusError(ConnectionNameAlreadyExists, {
        folderRid: current.compassFolderRid,
        name: patch.name,
      });
    }
  }

  // Rotate the mTLS client key into the vault when a new one is supplied; mirror
  // the encrypted-key flag onto the config that will be persisted.
  if (patch.clientKeyPem && patch.config?.connectorType === "postgresql") {
    const keyBytes = Buffer.from(patch.clientKeyPem, "utf8");
    await vault.createOrRotate(
      req.params.rid,
      user.tenant,
      "client_key",
      new Uint8Array(keyBytes),
      user.id,
    );
    keyBytes.fill(0);
    patch.config.postgres.clientKeyEncrypted = true;
  }

  const updated = await withTransaction(async (client) => {
    const next = await repo.update(
      client,
      req.params.rid,
      user.tenant,
      expected,
      {
        name: patch.name,
        description: patch.description,
        config: patch.config,
        egressPolicy: patch.egressPolicy,
        agentGroupRid: patch.agentGroupRid,
        settings: patch.settings,
      },
      user.id,
    );
    if (patch.name && patch.name !== current.name) {
      await outbox.enqueue(client, {
        connectionRid: req.params.rid,
        folderRid: current.compassFolderRid,
        operation: "renameResource",
        payload: { newDisplayName: patch.name, updatedBy: user.id },
      });
    }
    return next;
  });

  setConnectivityEtag(res, updated.version);
  res.status(200).json(updated);
});

export const deleteConnection = instrument(
  "/api/v2/connectivity/connections/:rid",
  "DELETE",
)(async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:write");

  const current = await repo.findByRid(req.params.rid, user.tenant);
  const expected = requireConnectivityIfMatch(req, current.version);

  if (await repo.hasActiveDependencies(req.params.rid)) {
    throw new TellusError(HasActiveDependencies, { rid: req.params.rid });
  }

  await withTransaction(async (client) => {
    await repo.softDelete(
      client,
      req.params.rid,
      user.tenant,
      expected,
      user.id,
    );
    await outbox.enqueue(client, {
      connectionRid: req.params.rid,
      folderRid: current.compassFolderRid,
      operation: "unregisterResource",
      payload: { deletedBy: user.id },
    });
  });

  res.status(204).send();
});

export const getConfiguration = instrument(
  "/api/v2/connectivity/connections/:rid/configuration",
  "GET",
)(async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:read");
  const conn = await repo.findByRid(req.params.rid, user.tenant);
  setConnectivityEtag(res, conn.version);
  res.status(200).json({
    rid: conn.rid,
    connectorType: conn.connectorType,
    workerType: conn.workerType,
    agentGroupRid: conn.agentGroupRid,
    config: conn.config,
    egressPolicy: conn.egressPolicy,
  });
});

export const getStatus = instrument(
  "/api/v2/connectivity/connections/:rid/status",
  "GET",
)(async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:read");
  const conn = await repo.findByRid(req.params.rid, user.tenant);
  setConnectivityEtag(res, conn.version);
  res.status(200).json({
    rid: conn.rid,
    state: conn.status.state,
    lastCheckedAt: conn.status.lastCheckedAt,
    details: conn.status.details,
  });
});

// --- centralized "not found" / 404 envelope when no route matches under /api/v2/connectivity/...
export function notFoundHandler(req: Request, res: Response): void {
  if (req.params.rid) {
    sendEnvelope(res, ConnectionNotFound, { rid: req.params.rid });
    return;
  }
  sendEnvelope(res, CompassFolderNotFound, { path: req.originalUrl });
}

// Type-only re-export to satisfy unused-import lint and document contract.
export type { Connection, ConnectionRid };
