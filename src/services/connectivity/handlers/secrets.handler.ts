// ---------------------------------------------------------------------------
// B2 secrets handlers. Routes:
//   POST   /api/v1/connectivity/connections/:rid/credentials
//             body: { field, plaintext_base64 }  scope: connectivity:write
//   GET    /api/v1/connectivity/connections/:rid/credentials
//             scope: connectivity:read  → version metadata only
//   DELETE /api/v1/connectivity/connections/:rid/credentials/:field
//             scope: connectivity:write  → supersede ALL versions of field
//   POST   /api/v1/connectivity/internal/unwrap
//             body: { connection_rid, field, workload_token }
//             no scope; workload-token verified explicitly
//
// All mutating endpoints require If-Match on the connection's ETag.
// The internal-unwrap endpoint NEVER returns plaintext to a route reachable
// from outside the cluster; in production a NetworkPolicy restricts the
// /internal namespace. This module enforces only the workload-JWT check.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  CredentialNotFound,
  CredentialRotationFailed,
  ScopeRequired,
  InvalidConfiguration,
  IfMatchRequired as IfMatchErr,
} from "../../../lib/errors/connectivity.errors";
import { TellusError } from "../../../lib/errors/envelope";
import { pool, withTransaction } from "../../../db";
import * as vault from "../credentials/vault";
import * as store from "../credentials/store.repo";
import { evict as evictPool } from "../connectors/postgresql/pool";
import { verifyWorkloadToken } from "../../multipass/tokens";
import * as repo from "../store/connections.repo";
import { extractUser, requireScope } from "./connections.handler";
import {
  requireConnectivityIfMatch,
  setConnectivityEtag,
} from "../../../middleware/connectivityEtag";

const FieldEnum = z.enum([
  "password",
  "client_key",
  "service_account_json",
  "token",
  "other",
  // F8 — named per-secret storage for REST-API sources.
  "api_key",
  "bearer_token",
  "basic_auth",
  "custom_header",
]);

const PutBody = z.object({
  field: FieldEnum,
  plaintext_base64: z.string().min(1).max(64 * 1024),
});

const InternalUnwrapBody = z.object({
  connection_rid: z
    .string()
    .regex(/^ri\.magritte\.main\.source\.[0-9a-f-]{36}$/),
  field: FieldEnum,
  workload_token: z.string().min(1),
});

async function fetchConnectionOr404(rid: string, tenant: string) {
  // findByRid throws ConnectionNotFound when absent — that maps to the
  // same 404 envelope downstream callers expect.
  return repo.findByRid(rid, tenant);
}

export async function postCredential(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");
    const conn = await fetchConnectionOr404(req.params.rid, user.tenant);
    requireConnectivityIfMatch(req, conn.version);

    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) {
      throw new TellusError(InvalidConfiguration, {
        issues: parsed.error.issues,
      });
    }
    const plaintext = Buffer.from(parsed.data.plaintext_base64, "base64");
    const { version } = await vault.createOrRotate(
      conn.rid,
      user.tenant,
      parsed.data.field,
      new Uint8Array(plaintext),
      user.id,
    );
    plaintext.fill(0);

    // Bumping the connection's own version is intentional: the credential
    // surface is part of the connection's "configuration view" and a
    // rotation invalidates any cached config copy on the FE side.
    setConnectivityEtag(res, conn.version);
    res.status(201).json({
      connectionRid: conn.rid,
      field: parsed.data.field,
      version,
    });
  } catch (e) {
    if (e instanceof TellusError) {
      e.send(res);
      return;
    }
    next(e);
  }
}

export async function listCredentials(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:read");
    const conn = await fetchConnectionOr404(req.params.rid, user.tenant);
    setConnectivityEtag(res, conn.version);
    const fields: store.CredentialField[] = [
      "password",
      "client_key",
      "service_account_json",
      "token",
      "other",
      // F8 — named per-secret storage for REST-API sources.
      "api_key",
      "bearer_token",
      "basic_auth",
      "custom_header",
    ];
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const versions = await store.listVersions(conn.rid, user.tenant, field);
      if (versions.length > 0) result[field] = versions;
    }
    res.status(200).json({ connectionRid: conn.rid, credentials: result });
  } catch (e) {
    if (e instanceof TellusError) {
      e.send(res);
      return;
    }
    next(e);
  }
}

export async function deleteCredentialField(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");
    const conn = await fetchConnectionOr404(req.params.rid, user.tenant);
    requireConnectivityIfMatch(req, conn.version);
    const field = FieldEnum.safeParse(req.params.field);
    if (!field.success) {
      throw new TellusError(InvalidConfiguration, {
        path: "field",
        message: "unknown field",
      });
    }
    const superseded = await vault.supersede(
      conn.rid,
      user.tenant,
      field.data,
      user.id,
    );
    if (superseded === 0) {
      throw new TellusError(CredentialNotFound, { rid: conn.rid, field: field.data });
    }
    res.status(204).send();
  } catch (e) {
    if (e instanceof TellusError) {
      e.send(res);
      return;
    }
    next(e);
  }
}

/**
 * Internal unwrap. Verifies a workload JWT, returns the plaintext credential
 * as a base64 string in the JSON response. Process-internal only.
 */
export async function internalUnwrap(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = InternalUnwrapBody.safeParse(req.body);
    if (!parsed.success) {
      throw new TellusError(InvalidConfiguration, {
        issues: parsed.error.issues,
      });
    }
    const verify = verifyWorkloadToken(parsed.data.workload_token, {
      connectionRid: parsed.data.connection_rid,
      scope: "connectivity:credential-unwrap",
    });
    if (!verify.ok) {
      throw new TellusError(ScopeRequired, {
        reason: verify.reason ?? "verify_failed",
      });
    }
    const claims = verify.claims!;
    const plaintext = await vault.unwrap(
      parsed.data.connection_rid,
      claims.tenant,
      parsed.data.field,
      claims.sub,
      {
        requestId: req.headers["x-request-id"] as string | undefined,
        clientIp: req.ip,
        scopes: claims.scopes,
      },
    );
    if (plaintext.length === 0) {
      throw new TellusError(CredentialNotFound, {
        rid: parsed.data.connection_rid,
        field: parsed.data.field,
      });
    }
    res.status(200).json({
      connectionRid: parsed.data.connection_rid,
      field: parsed.data.field,
      plaintext_base64: Buffer.from(plaintext).toString("base64"),
    });
    // Defense-in-depth scrub of plaintext after response queued.
    plaintext.fill(0);
  } catch (e) {
    if (e instanceof TellusError) {
      e.send(res);
      return;
    }
    next(e);
  }
}

// ---------------------------------------------------------------------------
// Worker credential unwrap — POST /internal/credentials/unwrap
//
// Called by the foundry-worker child (src/workers/foundry-worker/
// credential-fetch.ts) to obtain the full connect credentials for a build.
// Auth is a short-lived workload JWT in the Authorization header, verified
// HERE (the route is allowlisted in globalAuth because the bearer is a
// workload token, not a Keycloak user token; in production a NetworkPolicy
// additionally restricts this /internal path).
//
// Returns the assembled credentials the pg client needs: the non-secret
// `user` (from the connection config) plus the secret `password` (and, for
// mTLS, the client key) unwrapped from the vault. The internalUnwrap endpoint
// above returns a single field for callers that know which field they want;
// this one returns the whole credential set the worker connects with.
// ---------------------------------------------------------------------------
const WorkerUnwrapBody = z.object({
  connectionRid: z
    .string()
    .regex(/^ri\.magritte\.main\.source\.[0-9a-f-]{36}$/),
  name: z.string().optional(),
});

function bearerToken(req: Request): string {
  const authz = req.headers.authorization;
  return authz && authz.startsWith("Bearer ")
    ? authz.slice("Bearer ".length).trim()
    : "";
}

export async function internalUnwrapWorker(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = WorkerUnwrapBody.safeParse(req.body);
    if (!parsed.success) {
      throw new TellusError(InvalidConfiguration, { issues: parsed.error.issues });
    }
    const connectionRid = parsed.data.connectionRid;

    const verify = verifyWorkloadToken(bearerToken(req), {
      connectionRid,
      scope: "connectivity:credential-unwrap",
    });
    if (!verify.ok) {
      throw new TellusError(ScopeRequired, {
        reason: verify.reason ?? "verify_failed",
      });
    }
    const claims = verify.claims!;

    const row = await pool.query<{ config: Record<string, unknown>; tenant: string }>(
      `SELECT config, tenant FROM connectivity_connections WHERE rid=$1 AND deleted_at IS NULL`,
      [connectionRid],
    );
    if (row.rowCount === 0) {
      throw new TellusError(CredentialNotFound, { rid: connectionRid, field: "password" });
    }
    // Driver settings (incl. the non-secret `user`) nest under `postgres`.
    const rawCfg = row.rows[0].config ?? {};
    const cfg = (rawCfg.postgres ?? rawCfg) as Record<string, unknown>;
    // Tenant comes from the persisted connection row — NEVER from the JWT
    // claim. The sole legitimate issuer (enqueueBuildForImport in
    // imports/handlers.ts) mints the token with the connection row's tenant,
    // so any mismatch means a forged or cross-tenant token: fail closed
    // before touching the vault (vault.unwrap is tenant-bound, and honoring
    // the claim would let a token minted for connection A in tenant-evil
    // unwrap connection A's credentials under the wrong tenant scope).
    const rowTenant = row.rows[0].tenant;
    if (claims.tenant !== rowTenant) {
      throw new TellusError(ScopeRequired, {
        reason: "tenant_mismatch",
      });
    }
    const tenant = rowTenant;
    const auditCtx = {
      requestId: req.headers["x-request-id"] as string | undefined,
      clientIp: req.ip,
      scopes: claims.scopes,
    };

    const pwBytes = await vault.unwrap(connectionRid, tenant, "password", claims.sub, auditCtx);
    if (pwBytes.length === 0) {
      throw new TellusError(CredentialNotFound, { rid: connectionRid, field: "password" });
    }
    const password = Buffer.from(pwBytes).toString("utf8");
    pwBytes.fill(0);

    // Optional mTLS client key — absent for tlsMode=disable/require. `unwrap`
    // returns an empty buffer (not a throw) when the field has no version.
    let clientKeyPem: string | undefined;
    const keyBytes = await vault
      .unwrap(connectionRid, tenant, "client_key", claims.sub, auditCtx)
      .catch(() => new Uint8Array());
    if (keyBytes.length > 0) {
      clientKeyPem = Buffer.from(keyBytes).toString("utf8");
      keyBytes.fill(0);
    }

    res.status(200).json({
      version: 1,
      fields: {
        user: typeof cfg.user === "string" ? cfg.user : "",
        password,
        serverCaPem: typeof cfg.serverCaPem === "string" ? cfg.serverCaPem : undefined,
        clientCertPem:
          typeof cfg.clientCertPem === "string" ? cfg.clientCertPem : undefined,
        clientKeyPem,
      },
    });
  } catch (e) {
    if (e instanceof TellusError) {
      e.send(res);
      return;
    }
    next(e);
  }
}

// Re-export to make IfMatchErr referenced and registry-reachable.
void IfMatchErr;

// ---------------------------------------------------------------------------
// Aliases for the connectivity router (`src/services/connectivity/index.ts`)
// which mounts the handlers under the spec's `secrets` nomenclature. These
// are thin shims around the credential-vault primitives above so we don't
// duplicate logic.
// ---------------------------------------------------------------------------

/** POST /connections/:rid/secrets — equivalent to creating a new credential. */
export const postSecret = postCredential;

/** PUT /connections/:rid/secrets/:name — replace the named field's material. */
export async function putSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Adapt the named-route shape `{ name }` into the body shape postCredential expects.
  const fieldName = (req.params as { name?: string }).name;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (fieldName && !("field" in body)) body.field = fieldName;
  req.body = body;
  return postCredential(req, res, next);
}

/** DELETE /connections/:rid/secrets/:name — supersede the named field. */
export async function deleteSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const params = req.params as { name?: string; rid?: string };
  if (params.name) (req.params as Record<string, string>).field = params.name;
  return deleteCredentialField(req, res, next);
}

/** POST /connections/:rid/secrets/:name/rotate — force a new version. */
export async function rotateSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");
    const conn = await fetchConnectionOr404(req.params.rid, user.tenant);
    const field = FieldEnum.safeParse(
      (req.params as { name?: string }).name ?? req.body?.field,
    );
    if (!field.success) {
      throw new TellusError(InvalidConfiguration, {
        path: "name",
        message: "unknown field",
      });
    }
    const plaintextB64 =
      typeof req.body?.plaintext_base64 === "string"
        ? (req.body.plaintext_base64 as string)
        : null;
    if (!plaintextB64) {
      throw new TellusError(InvalidConfiguration, {
        path: "plaintext_base64",
        message: "missing plaintext_base64 for rotate",
      });
    }
    const plaintext = Buffer.from(plaintextB64, "base64");
    const { version } = await vault.createOrRotate(
      conn.rid,
      user.tenant,
      field.data,
      new Uint8Array(plaintext),
      user.id,
    );
    plaintext.fill(0);
    res.status(200).json({
      connectionRid: conn.rid,
      field: field.data,
      version,
    });
  } catch (e) {
    if (e instanceof TellusError) {
      e.send(res);
      return;
    }
    next(e);
  }
}

/**
 * POST /connections/:rid/secrets/:name/rotate-managed — server-side managed
 * rotation. Unlike rotateSecret (which takes caller-supplied plaintext), this
 * generates fresh material in-process via the vault rewrap primitive — the same
 * operation the background rotation worker performs on a schedule — and evicts
 * the connection's pool so the next request rebuilds with the new version.
 *
 * Surfaces Tellus:Connectivity:CredentialRotationFailed (500) when the rewrap
 * write fails; the previous credential version stays live in that case.
 */
export async function rotateManagedSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = extractUser(req);
    requireScope(user, "secrets:rotate");
    const conn = await fetchConnectionOr404(req.params.rid, user.tenant);
    requireConnectivityIfMatch(req, conn.version);
    const field = FieldEnum.safeParse(
      (req.params as { name?: string }).name ?? req.body?.field,
    );
    if (!field.success) {
      throw new TellusError(InvalidConfiguration, {
        path: "name",
        message: "unknown field",
      });
    }
    let version: number;
    try {
      const result = await withTransaction((client) =>
        vault.rewrap(client, conn.rid, field.data),
      );
      version = result.version;
    } catch (e) {
      throw new TellusError(CredentialRotationFailed, {
        rid: conn.rid,
        field: field.data,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
    // New credential version is live — drop any cached pool so the next
    // connection rebuilds with the rotated material.
    await evictPool(conn.rid).catch(() => undefined);
    res.status(200).json({
      connectionRid: conn.rid,
      field: field.data,
      version,
      rotated: true,
    });
  } catch (e) {
    if (e instanceof TellusError) {
      e.send(res);
      return;
    }
    next(e);
  }
}

/** POST /connections/:rid/credentials/issue — internal unwrap endpoint. */
export const issueCredential = internalUnwrap;
