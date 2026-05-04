// ---------------------------------------------------------------------------
// Code Repositories — POST idempotency middleware.
//
// Spec contracts:
//   G-C-20  Every POST that mutates state requires Idempotency-Key
//   G-C-21  Idempotency keys scoped per-principal, dedup on (principal, key)
//   G-C-22  Same key + different request body → 409 IdempotencyConflict
//   G-C-23  24h TTL on idempotency rows; older keys may be reused freely
//   G-C-25  Replay returns the captured response verbatim with X-Idempotent-Replay: true
//
// The middleware sits AFTER requireCodeReposAuth (so principal is bound)
// and BEFORE the route handler. On first request it lets the handler
// run, captures the response, persists it; on retry it short-circuits
// with the captured response. Conflicts (same key, different body)
// short-circuit with a 409 envelope and DO NOT run the handler.
//
// The capture logic uses a small Express response interceptor — we
// override `res.json` and `res.status` so we can observe the final
// status + body the handler produced. We deliberately do not capture
// streaming responses (res.write); idempotent endpoints must use json.
//
// Storage is Postgres (table `code_repos_idempotency`, migration 032).
// Reads + writes occur in their own transaction so the middleware is
// independent of the route handler's transaction; replay is a pure read.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../audit/canonicalJson";
import { isValidIdempotencyKey } from "../contracts/idempotency";
import { buildEnvelope, ERROR_CODES } from "../contracts/errors";

const TTL_HOURS = 24;
export const IDEMPOTENT_REPLAY_HEADER = "X-Idempotent-Replay";

/**
 * Compute the canonical request hash. Identical hashes mean identical
 * requests for the purposes of G-C-22 (same key + different body =
 * 409). The hash covers the HTTP method, the path, the principal user
 * id (defence-in-depth — even if the (principal, key) PK is bypassed,
 * the hash will diverge), and the request body. We deliberately do NOT
 * include headers because retries from a different network path (e.g.
 * different X-Request-Id) must dedup.
 */
export function computeRequestHash(
  method: string,
  path: string,
  principalUserId: string,
  body: unknown,
): string {
  const canon = canonicalJson({
    method: method.toUpperCase(),
    path,
    principal_user_id: principalUserId,
    body: (body ?? {}) as Record<string, unknown>,
  });
  return createHash("sha256").update(canon, "utf8").digest("hex");
}

export interface IdempotencyDeps {
  readonly pool: Pool;
  /**
   * Optional list of route-paths that bypass idempotency entirely. Use
   * for non-mutating POSTs (e.g. policy-decision endpoints that perform
   * no DB writes). The match is done against `req.path` (router-relative)
   * with exact-string equality. POSTs to any other path require an
   * Idempotency-Key per G-C-20.
   */
  readonly skipPaths?: readonly string[];
}

/**
 * Express middleware factory. Mount on POST routes that require
 * Idempotency-Key. Non-POST methods pass through untouched.
 */
export function idempotencyMiddleware(deps: IdempotencyDeps) {
  const { pool, skipPaths } = deps;
  const skipSet: ReadonlySet<string> = new Set(skipPaths ?? []);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method !== "POST") {
      next();
      return;
    }
    if (skipSet.has(req.path)) {
      next();
      return;
    }

    const principal = req.codeReposPrincipal;
    if (!principal) {
      // requireCodeReposAuth must run before this middleware; absence
      // is a wiring defect, not a client error.
      sendEnvelope(res, 500, "Stemma:InternalError", ERROR_CODES.INTERNAL, {
        message: "idempotencyMiddleware: principal not bound",
      });
      return;
    }

    const key = req.header("Idempotency-Key");
    if (!key) {
      sendEnvelope(res, 400, "Stemma:MissingIdempotencyKey", ERROR_CODES.INVALID_ARGUMENT, {
        header: "Idempotency-Key",
        message: "Idempotency-Key header is required for POST requests",
      });
      return;
    }
    if (!isValidIdempotencyKey(key)) {
      sendEnvelope(res, 400, "Stemma:InvalidIdempotencyKey", ERROR_CODES.INVALID_ARGUMENT, {
        header: "Idempotency-Key",
        message: "Idempotency-Key must be a UUID, ULID, or 16-128 hex chars",
      });
      return;
    }

    const requestHash = computeRequestHash(req.method, req.path, principal.userId, req.body);

    // Lookup. If a row exists and is unexpired, either replay (hash
    // matches) or 409 (hash differs). If unexpired with matching hash:
    // replay. If expired: ignore the row and proceed to first-write.
    let existing: {
      response_status: number;
      response_body: unknown;
      response_etag: string | null;
      request_hash: string;
      expires_at: Date;
    } | null = null;
    try {
      const r = await pool.query<{
        response_status: number;
        response_body: unknown;
        response_etag: string | null;
        request_hash: string;
        expires_at: Date;
      }>(
        `SELECT response_status, response_body, response_etag, request_hash, expires_at
           FROM code_repos_idempotency
          WHERE principal_user_id = $1 AND idem_key = $2`,
        [principal.userId, key],
      );
      existing = r.rowCount === 1 ? r.rows[0] : null;
    } catch (err) {
      // DB outage on the idempotency table — fail closed (don't run the
      // handler, since we cannot dedup; surface 503).
      sendEnvelope(res, 503, "Stemma:IdempotencyStoreUnavailable", ERROR_CODES.UNAVAILABLE, {
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // expires_at arrives as a Date object normally, but pg sometimes
    // hands back a string for TIMESTAMPTZ columns when the parser is
    // overridden upstream. Coerce defensively so the middleware never
    // crashes on a 200-style happy path.
    const expiresAtMs =
      existing && existing.expires_at
        ? (existing.expires_at instanceof Date
            ? existing.expires_at.getTime()
            : new Date(existing.expires_at as string).getTime())
        : 0;
    if (existing && expiresAtMs > Date.now()) {
      if (existing.request_hash !== requestHash) {
        // G-C-22 — same key, different body → 409 IdempotencyConflict.
        sendEnvelope(res, 409, "Stemma:IdempotencyConflict", ERROR_CODES.CONFLICT, {
          header: "Idempotency-Key",
          message: "Idempotency-Key was previously used with a different request body",
        });
        return;
      }
      // G-C-25 — replay verbatim.
      res.setHeader(IDEMPOTENT_REPLAY_HEADER, "true");
      if (existing.response_etag) {
        res.setHeader("ETag", existing.response_etag);
      }
      res.status(existing.response_status).json(existing.response_body);
      return;
    }

    // First-write path. Wrap res.json so we capture the final response
    // AND durably persist the idempotency row BEFORE the bytes hit the
    // socket. This is what makes G-C-25 (replay) actually safe: the
    // contract is "if a client saw 2xx, the next retry replays it", and
    // the only way to keep that promise is to make the row durable
    // before the client can observe the response.
    //
    // Why not res.on("finish")? Earlier versions of this middleware
    // persisted there — fire-and-forget after the response flushed —
    // which created a race window. A client that retried fast enough
    // (or a test that polled the response then immediately re-POSTed)
    // could race past the deferred INSERT and find an empty table,
    // re-run the handler, and double-execute. Fix: synchronize the
    // INSERT into the response path.
    let finalStatus = 200;
    const origStatus = res.status.bind(res);
    res.status = (code: number): Response => {
      finalStatus = code;
      return origStatus(code);
    };
    const origJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      const etag = (res.getHeader("ETag") as string | undefined) ?? null;
      const cap = { status: finalStatus, body, etag };
      // Non-2xx: do not persist (avoids replaying transient 5xx forever).
      if (cap.status < 200 || cap.status >= 300) {
        return origJson(body);
      }
      // 2xx: persist FIRST, then flush. Express handlers don't await
      // res.json — they `return res.status(…).json(…)` and let the
      // response stream finish on its own — so deferring the actual
      // origJson() call until after the INSERT resolves is transparent
      // to the handler. The supertest/HTTP client awaits the network
      // response, which arrives only after origJson() runs, so by the
      // time a retry can be issued the row is durable.
      //
      // Persist failure does NOT fail the response: we still flush in
      // `.finally`, with a warning. The cost is that one specific
      // retry path (DB went away after handler succeeded) won't be
      // deduped — strictly better than dropping the response entirely.
      const expiresAt = new Date(Date.now() + TTL_HOURS * 3_600_000);
      pool
        .query(
          `INSERT INTO code_repos_idempotency
             (principal_user_id, idem_key, request_hash,
              response_status, response_body, response_etag, expires_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (principal_user_id, idem_key) DO UPDATE
             SET request_hash    = EXCLUDED.request_hash,
                 response_status = EXCLUDED.response_status,
                 response_body   = EXCLUDED.response_body,
                 response_etag   = EXCLUDED.response_etag,
                 expires_at      = EXCLUDED.expires_at`,
          [
            principal.userId,
            key,
            requestHash,
            cap.status,
            JSON.stringify(cap.body),
            cap.etag,
            expiresAt.toISOString(),
          ],
        )
        .catch((err: Error) => {
          // best-effort surface; middleware deliberately has no logger dep
          console.warn(
            `[code-repos] failed to persist idempotency row for key=${key} principal=${principal.userId}: ${err.message}`,
          );
        })
        .finally(() => {
          origJson(body);
        });
      return res;
    };

    next();
  };
}

function sendEnvelope(
  res: Response,
  status: number,
  errorName: string,
  errorCode: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  parameters: Record<string, unknown>,
): void {
  res.status(status).json(
    buildEnvelope({
      errorCode,
      errorName,
      parameters,
    }),
  );
}
