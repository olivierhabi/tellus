// Workshop / G-03 — Idempotency-Key handling.
//
// Spec §0.3: store `(idempotency_key, user_id, route, sha256(body))` for 24h
// in `workshop_idempotency_record`. Same key + same body → cached response;
// same key + different body → 409 Tellus:Workshop:IdempotencyKeyReused.
// Decision D-09.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getWorkshopDb } from "./db";
import { idempotencyKeyReused } from "./errors";

export interface IdempotencyHit {
  responseStatus: number;
  responseBody: unknown;
  responseEtag: string | null;
}

export interface IdempotencyContext {
  key: string;
  userId: string;
  route: string;
  bodySha256: Buffer;
}

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidIdempotencyKey(key: string): boolean {
  return UUID_V4_REGEX.test(key);
}

/**
 * Stable canonical JSON: object keys are sorted recursively, arrays preserve
 * order, primitives serialize identically. Reuses the same approach as
 * `canonicalizeJson` in etag.ts but local here to avoid a cycle.
 */
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map(canonicalize).join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
      .join(",") +
    "}"
  );
}

export function hashBody(body: unknown): Buffer {
  const normalized = canonicalize(body);
  return createHash("sha256").update(normalized, "utf8").digest();
}

/**
 * Look up an existing idempotency record. If found:
 *   - bytes-equal body → return the cached response (caller should reply
 *     with that body and 200 Cached).
 *   - different body   → throws `IdempotencyKeyReused` (409).
 * If not found, returns null and the caller should proceed with the
 * underlying operation, then call `recordResponse`.
 *
 * Optionally accepts a transaction client so the read happens inside the
 * same transaction as the operation (avoids race between lookup and
 * record).
 */
export async function lookupIdempotency(
  ctx: IdempotencyContext,
  client?: PoolClient,
): Promise<IdempotencyHit | null> {
  const sql = `
    SELECT response_status, response_body, response_etag, body_sha256
      FROM workshop_idempotency_record
     WHERE idempotency_key = $1
       AND user_id = $2
       AND route   = $3
       AND expires_at > now()
     LIMIT 1`;
  const params = [ctx.key, ctx.userId, ctx.route];
  const result = client
    ? await client.query(sql, params)
    : await getWorkshopDb().query(sql, params);

  if (result.rows.length === 0) return null;
  const row = result.rows[0] as {
    response_status: number;
    response_body: unknown;
    response_etag: string | null;
    body_sha256: Buffer;
  };
  if (!row.body_sha256.equals(ctx.bodySha256)) {
    throw idempotencyKeyReused(ctx.key);
  }
  return {
    responseStatus: row.response_status,
    responseBody: row.response_body,
    responseEtag: row.response_etag,
  };
}

/**
 * Persist the response so future requests with the same idempotency key
 * see a deterministic replay. Called only on success (4xx/5xx are not
 * cached — clients should be able to retry after fixing the request).
 */
export async function recordResponse(
  ctx: IdempotencyContext,
  status: number,
  body: unknown,
  etag: string | null,
  client?: PoolClient,
): Promise<void> {
  const sql = `
    INSERT INTO workshop_idempotency_record
      (idempotency_key, user_id, route, body_sha256,
       response_status, response_body, response_etag)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    ON CONFLICT (idempotency_key, user_id, route) DO NOTHING`;
  const params = [
    ctx.key,
    ctx.userId,
    ctx.route,
    ctx.bodySha256,
    status,
    JSON.stringify(body),
    etag,
  ];
  if (client) {
    await client.query(sql, params);
  } else {
    await getWorkshopDb().query(sql, params);
  }
}
