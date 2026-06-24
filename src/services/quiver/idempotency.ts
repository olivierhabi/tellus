// Quiver idempotency cache (G-04, D-09).
//
// Postgres-backed table `quiver_idempotency_record`; replay returns the
// cached response byte-for-byte. Reuse with different body (same key,
// different body sha256) → 409 IdempotencyKeyReplay.
//
// 24h TTL via `expires_at` column + a periodic sweep (D-05).

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query } from "../../db";
import { idempotencyKeyReplay } from "./errors";

export interface IdempotencyContext {
  key: string;
  userId: string;
  route: string;
  bodySha256: Buffer;
}

export interface CachedResponse {
  status: number;
  body: unknown;
  etag: string | null;
}

export function bodyHash(body: unknown): Buffer {
  // Canonical JSON for hashing — we want stable replay detection regardless
  // of key order in the source object.
  return createHash("sha256")
    .update(canonical(body), "utf8")
    .digest();
}

function canonical(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") +
      "}";
  }
  return "null";
}

export function makeContext(opts: {
  key: string;
  userId: string;
  route: string;
  body: unknown;
}): IdempotencyContext {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(opts.key)) {
    throw new Error("idempotency-key must match /^[A-Za-z0-9_-]{1,200}$/");
  }
  return {
    key: opts.key,
    userId: opts.userId,
    route: opts.route,
    bodySha256: bodyHash(opts.body),
  };
}

export async function lookup(
  ctx: IdempotencyContext,
  client?: PoolClient,
): Promise<CachedResponse | null> {
  const sql = `
    SELECT response_status, response_body, response_etag, body_sha256
    FROM quiver_idempotency_record
    WHERE idempotency_key = $1
      AND user_id = $2
      AND route = $3
      AND expires_at > now()
    LIMIT 1
  `;
  const r = client
    ? await client.query(sql, [ctx.key, ctx.userId, ctx.route])
    : await query(sql, [ctx.key, ctx.userId, ctx.route]);
  if (r.rowCount === 0) return null;
  const row = r.rows[0] as {
    response_status: number;
    response_body: unknown;
    response_etag: string | null;
    body_sha256: Buffer;
  };
  if (!row.body_sha256.equals(ctx.bodySha256)) {
    throw idempotencyKeyReplay({ key: ctx.key });
  }
  return {
    status: row.response_status,
    body: row.response_body,
    etag: row.response_etag,
  };
}

export async function record(
  ctx: IdempotencyContext,
  status: number,
  body: unknown,
  etag: string | null,
  client?: PoolClient,
): Promise<void> {
  const sql = `
    INSERT INTO quiver_idempotency_record (
      idempotency_key, user_id, route, body_sha256,
      response_status, response_body, response_etag,
      created_at, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6::jsonb, $7, now(), now() + interval '24 hours'
    )
    ON CONFLICT (idempotency_key, user_id, route)
    DO NOTHING
  `;
  const params = [
    ctx.key,
    ctx.userId,
    ctx.route,
    ctx.bodySha256,
    status,
    JSON.stringify(body),
    etag,
  ];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

/** Generate a new uuid for cases where the caller forgot the header. */
export function newKey(): string {
  return randomUUID();
}
