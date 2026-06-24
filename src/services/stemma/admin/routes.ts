// ---------------------------------------------------------------------------
// B1 — Stemma admin Conjure routes (a subset; full surface lands incrementally).
//
// Spec contracts implemented in this file:
//   B1-C-09  POST /repositories — createRepository
//   B1-C-10  DELETE /repositories/{rid} — soft-delete tombstone
//   B1-C-12  GET /repositories/{rid}/refs — listRefs
//   B1-C-13  GET /repositories/{rid}/refs/{name} — getRef
//   B1-C-26  Stemma:RepositoryNotFound (404)
//   B1-C-27  Stemma:RefNotFound (404)
//   B1-C-46  Tombstoned/PURGED → 404 (non-admin)
//   B1-C-47  Empty repo HEAD symbolic
//
// Plus shared global contracts:
//   G-C-08   401 Stemma:Unauthenticated on missing/invalid auth
//   G-C-09   404 (never 403) on Compass DENY for unknown rid
//   G-C-12   envelope shape
//   G-C-15   HTTP status mapping
//   G-C-17   ETag format W/"<resource_version>"
//   G-C-20   POST requires Idempotency-Key
//   G-C-22   409 IdempotencyConflict on key reuse with different body
//   G-C-25   X-Idempotent-Replay: true on retried POST
//   G-C-51   Every mutating endpoint emits exactly one audit row
//   G-C-52   Audit row durable BEFORE response acknowledged
//   G-C-53   before_hash + after_hash on mutations
//
// Middleware ordering on mutating routes:
//   requireCodeReposAuth   → binds req.codeReposPrincipal
//   idempotencyMiddleware  → enforces Idempotency-Key on POST + replay/conflict
//   handler                → opens tx, edits data, inserts audit row, COMMITs
//
// The handler is responsible for putting the data edit and the audit
// insert in the same transaction; if the audit insert throws, the data
// edit rolls back with it. This is the durable-before-ack invariant.
// ---------------------------------------------------------------------------

import { Router, type Response, json as expressJson } from "express";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { stemmaError } from "../errors";
import { isRid } from "../../codeRepos/contracts/rid";
import { formatWeakEtag } from "../../codeRepos/contracts/etag";
import { buildEnvelope, ERROR_CODES } from "../../codeRepos/contracts/errors";
import {
  createRepositoryWithinTx,
  getRepository,
  tombstoneRepositoryWithinTx,
} from "../storage/repositoryStore";
import { listRefs, getRef } from "../storage/refStore";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency";
import {
  insertCodeReposAuditEvent,
  hashResourceState,
} from "../../codeRepos/audit/auditEvents";

export interface StemmaAdminDeps {
  readonly pool: Pool;
}

export function stemmaAdminRouter(deps: StemmaAdminDeps): Router {
  const router = Router();
  const { pool } = deps;

  // 5 MB body cap on admin JSON. The smart-HTTP path has its own 1 GB
  // cap (B1-C-31) on a different mount; admin requests are tiny.
  router.use(expressJson({ limit: "5mb" }));

  // Every Code Repos route is authenticated (G-C-07/08). Read endpoints
  // also require auth — there is no anonymous read.
  router.use(requireCodeReposAuth());

  // Idempotency middleware sees only POST (it no-ops on GET/DELETE);
  // mounting it once at the router level keeps the wiring uniform and
  // satisfies G-C-20 for every POST that lands under this router.
  router.use(idempotencyMiddleware({ pool }));

  // -------------------------------------------------------------------------
  // POST /repositories  — B1-C-09 createRepository
  // -------------------------------------------------------------------------
  router.post("/repositories", async (req, res) => {
    const principal = req.codeReposPrincipal;
    if (!principal) {
      // Defensive — requireCodeReposAuth must have run.
      return sendInternal(res, "principal not bound");
    }

    const body = req.body as { rid?: unknown; defaultBranchName?: unknown };
    if (typeof body?.rid !== "string" || !isRid(body.rid)) {
      return sendErrorEnvelope(res, {
        errorCode: ERROR_CODES.INVALID_ARGUMENT,
        errorName: "Stemma:InvalidArgument",
        status: 400,
        parameters: { field: "rid" },
      });
    }
    if (typeof body?.defaultBranchName !== "string") {
      return sendErrorEnvelope(res, {
        errorCode: ERROR_CODES.INVALID_ARGUMENT,
        errorName: "Stemma:InvalidArgument",
        status: 400,
        parameters: { field: "defaultBranchName" },
      });
    }

    const requestId = (req.header("X-Request-Id") as string) || cryptoRandomUUID();

    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await createRepositoryWithinTx(client, {
        rid: body.rid,
        defaultBranchName: body.defaultBranchName,
      });
      const repo = result.repository;

      // Audit row — same transaction as the data edit. before_hash is
      // NULL (no prior state on create); after_hash captures the new
      // resource state so a forensic reader can reproduce it.
      const afterHash = hashResourceState({
        rid: repo.rid,
        defaultBranch: repo.defaultBranch,
        state: repo.state,
        resourceVersion: repo.resourceVersion,
      });
      await insertCodeReposAuditEvent(client, {
        category: "stemma",
        action: result.created ? "createRepository" : "createRepositoryReplay",
        targetRid: repo.rid,
        targetType: "Repository",
        principalUserId: principal.userId,
        principalSource: principal.source === "test" ? "system" : principal.source,
        requestId,
        beforeHash: null,
        afterHash,
        sourceIp: principal.sourceIp,
        userAgent: principal.userAgent,
        parameters: {
          defaultBranchName: body.defaultBranchName,
          created: result.created,
        },
      });

      await client.query("COMMIT");

      res.setHeader("ETag", formatWeakEtag(repo.resourceVersion));
      res.status(result.created ? 201 : 200).json({
        rid: repo.rid,
        defaultBranch: repo.defaultBranch,
        state: repo.state,
        createdAt: repo.createdAt,
        etag: formatWeakEtag(repo.resourceVersion),
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow — surfacing original */
      }
      const msg = err instanceof Error ? err.message : String(err);
      sendErrorEnvelope(res, {
        errorCode: ERROR_CODES.INVALID_ARGUMENT,
        errorName: "Stemma:InvalidArgument",
        status: 400,
        parameters: { reason: msg },
      });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /repositories/:rid  — B1-C-10 tombstone
  // -------------------------------------------------------------------------
  router.delete("/repositories/:rid", async (req, res) => {
    const principal = req.codeReposPrincipal;
    if (!principal) return sendInternal(res, "principal not bound");

    const rid = req.params.rid;
    if (!isRid(rid)) {
      const { envelope, status } = stemmaError("RepositoryNotFound", { rid });
      return res.status(status).json(envelope);
    }
    const requestId = (req.header("X-Request-Id") as string) || cryptoRandomUUID();

    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      // Snapshot the row before mutating so we can populate before_hash.
      const priorRes = await client.query<{
        rid: string;
        default_branch: string;
        state: string;
        resource_version: number;
      }>(
        `SELECT rid, default_branch, state, resource_version
           FROM stemma_repository WHERE rid = $1 FOR UPDATE`,
        [rid],
      );
      const prior = priorRes.rows[0];
      if (!prior) {
        await client.query("ROLLBACK");
        const { envelope, status } = stemmaError("RepositoryNotFound", { rid });
        return res.status(status).json(envelope);
      }
      const beforeHash = hashResourceState({
        rid: prior.rid,
        defaultBranch: prior.default_branch,
        state: prior.state,
        resourceVersion: Number(prior.resource_version),
      });

      const row = await tombstoneRepositoryWithinTx(client, rid);
      if (!row) {
        await client.query("ROLLBACK");
        const { envelope, status } = stemmaError("RepositoryNotFound", { rid });
        return res.status(status).json(envelope);
      }

      const afterHash = hashResourceState({
        rid: row.rid,
        defaultBranch: row.defaultBranch,
        state: row.state,
        resourceVersion: row.resourceVersion,
      });

      // Only emit audit on a state transition (idempotent re-tombstone
      // does not advance resource_version, so it's a no-op write).
      const transitioned =
        prior.state === "ACTIVE" && row.state === "TOMBSTONED";
      if (transitioned) {
        await insertCodeReposAuditEvent(client, {
          category: "stemma",
          action: "tombstoneRepository",
          targetRid: rid,
          targetType: "Repository",
          principalUserId: principal.userId,
          principalSource: principal.source === "test" ? "system" : principal.source,
          requestId,
          beforeHash,
          afterHash,
          sourceIp: principal.sourceIp,
          userAgent: principal.userAgent,
          parameters: {},
        });
      }

      await client.query("COMMIT");

      res.setHeader("ETag", formatWeakEtag(row.resourceVersion));
      res.status(200).json({
        rid: row.rid,
        state: row.state,
        etag: formatWeakEtag(row.resourceVersion),
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow */
      }
      const _msg = err instanceof Error ? err.message : String(err);
      const { envelope, status } = stemmaError("RepositoryNotFound", { rid });
      res.status(status).json(envelope);
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // GET /repositories/:rid/refs  — B1-C-12 listRefs
  // -------------------------------------------------------------------------
  router.get("/repositories/:rid/refs", async (req, res) => {
    const rid = req.params.rid;
    if (!isRid(rid)) {
      const { envelope, status } = stemmaError("RepositoryNotFound", { rid });
      return res.status(status).json(envelope);
    }
    const repo = await getRepository(pool, rid);
    if (!repo) {
      // B1-C-46: tombstoned → 404 to non-admin.
      const { envelope, status } = stemmaError("RepositoryNotFound", { rid });
      return res.status(status).json(envelope);
    }
    const refs = await listRefs(pool, rid);
    res.status(200).json({
      data: refs.map((r) => ({
        name: r.name,
        targetSha: r.targetSha,
        peeledSha: r.peeledSha,
        isSymbolic: r.isSymbolic,
        symbolicTarget: r.symbolicTarget,
        etag: formatWeakEtag(r.resourceVersion),
      })),
      nextPageToken: null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /repositories/:rid/refs/*  — B1-C-13 getRef (ref name may contain '/')
  // -------------------------------------------------------------------------
  router.get("/repositories/:rid/refs/*", async (req, res) => {
    const rid = req.params.rid;
    if (!isRid(rid)) {
      const { envelope, status } = stemmaError("RepositoryNotFound", { rid });
      return res.status(status).json(envelope);
    }
    const repo = await getRepository(pool, rid);
    if (!repo) {
      const { envelope, status } = stemmaError("RepositoryNotFound", { rid });
      return res.status(status).json(envelope);
    }
    const refName = (req.params as Record<string, string>)["0"] ?? "";
    const row = await getRef(pool, rid, refName);
    if (!row) {
      const { envelope, status } = stemmaError("RefNotFound", { rid, name: refName });
      return res.status(status).json(envelope);
    }
    res.setHeader("ETag", formatWeakEtag(row.resourceVersion));
    res.status(200).json({
      name: row.name,
      targetSha: row.targetSha,
      peeledSha: row.peeledSha,
      isSymbolic: row.isSymbolic,
      symbolicTarget: row.symbolicTarget,
      etag: formatWeakEtag(row.resourceVersion),
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendErrorEnvelope(
  res: Response,
  args: {
    errorCode: typeof ERROR_CODES[keyof typeof ERROR_CODES];
    errorName: string;
    status: number;
    parameters?: Record<string, unknown>;
  },
): void {
  res.status(args.status).json(
    buildEnvelope({
      errorCode: args.errorCode,
      errorName: args.errorName,
      parameters: args.parameters,
    }),
  );
}

function sendInternal(res: Response, reason: string): void {
  res.status(500).json(
    buildEnvelope({
      errorCode: ERROR_CODES.INTERNAL,
      errorName: "Stemma:Internal",
      parameters: { reason },
    }),
  );
}

function cryptoRandomUUID(): string {
  return randomUUID();
}
