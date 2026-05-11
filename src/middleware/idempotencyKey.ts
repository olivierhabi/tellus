// ---------------------------------------------------------------------------
// Idempotency-Key — store + replay middleware for state-allocating POSTs.
// ---------------------------------------------------------------------------
// Behavior:
//   1. If the `Idempotency-Key` header is absent → pass through.
//   2. If the header is malformed (not a UUIDv4) → 400 INVALID_ARGUMENT.
//   3. If a row exists with the same key + same `request_hash` → replay
//      the cached (status, body) with `Idempotent-Replay: true` set.
//   4. If a row exists with the same key but a DIFFERENT `request_hash`
//      → 409 IDEMPOTENCY_KEY_CONFLICT.
//   5. Otherwise: tap `res.json` to capture the outbound response and
//      INSERT the row on success (status >= 200 && < 300). Storing on
//      the response path keeps key creation tied to a successful request.
//
// Storage: `idempotency_keys` table. TTL is enforced by `expires_at`,
// and the lookup query already filters expired rows so a missing sweep
// job is not a correctness hazard — only a space hazard.
// ---------------------------------------------------------------------------

import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { Counter, register } from "prom-client";
import { OntologyError } from "../utils/queryErrors";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Self-contained counter — registered defensively so test isolation does
// not trip prom-client's "metric already registered" guard.
function getOrCreateCounter(opts: ConstructorParameters<typeof Counter>[0]): Counter<string> {
  const existing = register.getSingleMetric(opts.name);
  if (existing) return existing as Counter<string>;
  return new Counter(opts);
}

const idempotentReplayTotal = getOrCreateCounter({
  name: "tellus_idempotent_replay_total",
  help: "Number of Idempotency-Key replays returned from cache.",
  labelNames: ["endpoint"] as const,
});

function hashRequestBody(body: unknown): string {
  const json = body === undefined ? "" : JSON.stringify(body);
  return createHash("sha256").update(json).digest("hex");
}

interface CacheRow {
  status_code: number;
  response_body: unknown;
  response_etag: string | null;
  request_hash: string;
}

/**
 * Build an Express middleware that intercepts requests bearing an
 * `Idempotency-Key` header for a given endpoint label. The label is
 * stored alongside the key so that the same UUID can address different
 * cache entries on different endpoints.
 *
 * The middleware is mounted *after* JSON body parsing so `req.body` is
 * available for hashing.
 */
export function idempotencyKeyMiddleware(pool: Pool, endpoint: string) {
  return async function idempotencyKey(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = req.headers["idempotency-key"] as string | undefined;
    if (!key) {
      next();
      return;
    }
    if (!UUID_V4_RE.test(key)) {
      next(
        new OntologyError(
          "Idempotency-Key header must be a UUIDv4.",
          "INVALID_ARGUMENT",
          400,
          { received: key },
        ),
      );
      return;
    }

    const requestHash = hashRequestBody(req.body);

    // Look up an existing, non-expired row.
    const lookup = await pool.query<CacheRow>(
      `SELECT status_code, response_body, response_etag, request_hash
       FROM idempotency_keys
       WHERE key = $1::uuid
         AND endpoint = $2
         AND expires_at > now()`,
      [key, endpoint],
    );

    if (lookup.rows.length > 0) {
      const row = lookup.rows[0];
      if (row.request_hash !== requestHash) {
        next(
          new OntologyError(
            "Idempotency-Key reused with a different request body.",
            "IDEMPOTENCY_KEY_CONFLICT",
            409,
            { key },
          ),
        );
        return;
      }
      idempotentReplayTotal.labels({ endpoint }).inc();
      res.setHeader("Idempotent-Replay", "true");
      if (row.response_etag) res.setHeader("ETag", row.response_etag);
      res.status(row.status_code).json(row.response_body);
      return;
    }

    // No row yet — tap res.json to capture the outbound response.
    const originalJson = res.json.bind(res);
    let captured = false;
    res.json = function (body: unknown): Response {
      if (!captured) {
        captured = true;
        const status = res.statusCode || 200;
        const etag = res.getHeader("ETag");
        const etagStr = typeof etag === "string" ? etag : null;
        // Persist only on success to avoid caching transient errors.
        if (status >= 200 && status < 300) {
          // Fire-and-forget: do NOT block the response on store latency.
          // ON CONFLICT DO NOTHING handles a duplicate-key race — the
          // second writer's response will be served from the cache on
          // next replay, which is correct because the contract requires
          // identical bodies to produce identical responses.
          pool
            .query(
              `INSERT INTO idempotency_keys
                 (key, endpoint, request_hash, status_code, response_body, response_etag)
               VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)
               ON CONFLICT (key) DO NOTHING`,
              [
                key,
                endpoint,
                requestHash,
                status,
                JSON.stringify(body ?? null),
                etagStr,
              ],
            )
            .catch((err) => {
              // eslint-disable-next-line no-console
              console.error(
                "[idempotency_keys] insert failed for key=%s endpoint=%s: %s",
                key,
                endpoint,
                err instanceof Error ? err.message : String(err),
              );
            });
        }
      }
      return originalJson(body);
    } as typeof res.json;

    next();
  };
}
