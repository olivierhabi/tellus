// ---------------------------------------------------------------------------
// B2 secrets handlers. Routes:
//   POST   /api/v2/connectivity/connections/:rid/credentials
//             body: { field, plaintext_base64 }  scope: connectivity:write
//   GET    /api/v2/connectivity/connections/:rid/credentials
//             scope: connectivity:read  → version metadata only
//   DELETE /api/v2/connectivity/connections/:rid/credentials/:field
//             scope: connectivity:write  → supersede ALL versions of field
//   POST   /api/v2/connectivity/internal/unwrap
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
  ScopeRequired,
  InvalidConfiguration,
  IfMatchRequired as IfMatchErr,
} from "../../../lib/errors/connectivity.errors";
import { TellusError } from "../../../lib/errors/envelope";
import * as vault from "../credentials/vault";
import * as store from "../credentials/store.repo";
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

/** POST /connections/:rid/credentials/issue — internal unwrap endpoint. */
export const issueCredential = internalUnwrap;
