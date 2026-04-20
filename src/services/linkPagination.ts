// ---------------------------------------------------------------------------
// LT-B9 — search_after / PIT pagination
//
// Replaces the O(offset) Quickwit/OpenSearch deep-pagination cliff with
// a search_after token carrying (sort keys, pit_id). PITs are tracked in
// Redis (shared with the Funnel overlay) with a 5-minute TTL; a
// Postgres fallback (`link_pagination_session`) covers environments
// without Redis.
// ---------------------------------------------------------------------------

import { query } from "../db";
import { appError } from "../utils/appError";

const MAX_OFFSET = 10_000;
const DEFAULT_PIT_TTL_SECONDS = 5 * 60;

export type PaginationMode = "offset" | "search_after";

export interface SearchAfterToken {
  sort_keys: unknown[];
  pit_id: string | null;
  backend: "opensearch" | "iceberg";
  snapshot_id?: string;
  last_source_pk?: string;
  last_target_pk?: string;
}

export class OffsetTooDeepError extends Error {
  code = "OFFSET_TOO_DEEP_USE_SEARCH_AFTER" as const;
  maxOffset = MAX_OFFSET;
  constructor() {
    super(
      `offset paging beyond ${MAX_OFFSET} is no longer supported — use paginationMode=search_after`
    );
  }
}

export class PitExpiredError extends Error {
  code = "PIT_EXPIRED" as const;
  constructor(pitId: string) {
    super(`point-in-time '${pitId}' has expired — restart pagination from page 1`);
  }
}

export function encodeSearchAfter(token: SearchAfterToken): string {
  return Buffer.from(JSON.stringify(token)).toString("base64url");
}

export function decodeSearchAfter(tokenStr: string): SearchAfterToken {
  try {
    const parsed = JSON.parse(Buffer.from(tokenStr, "base64url").toString());
    if (!parsed || typeof parsed !== "object") {
      throw new Error("not-an-object");
    }
    return parsed as SearchAfterToken;
  } catch {
    throw appError(
      "INVALID_SEARCH_AFTER_TOKEN",
      "Provided searchAfterToken is not a valid base64url payload."
    );
  }
}

/**
 * Enforce the 10k offset cap before we even ask Quickwit. Callers should
 * surface `OFFSET_TOO_DEEP_USE_SEARCH_AFTER` to the client.
 */
export function assertOffsetWithinCap(offset: number): void {
  if (offset > MAX_OFFSET) {
    throw new OffsetTooDeepError();
  }
}

// ---------------------------------------------------------------------------
// PIT session store — Redis-first, Postgres fallback.
// ---------------------------------------------------------------------------

export interface PitRecord {
  pit_id: string;
  ontology_id: string;
  link_type_id?: string;
  backend: "opensearch" | "iceberg";
  state: Record<string, unknown>;
}

type RedisLike = {
  set: (key: string, value: string, opts?: unknown) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  expire: (key: string, seconds: number) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
};

let redisInstance: RedisLike | null | undefined;

async function getRedis(): Promise<RedisLike | null> {
  if (redisInstance !== undefined) return redisInstance;
  try {
    const mod: any = await import("redis");
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    const client = mod.createClient({ url });
    client.on("error", () => {
      /* silenced — fall back to Postgres */
    });
    await client.connect();
    redisInstance = client as RedisLike;
  } catch {
    redisInstance = null;
  }
  return redisInstance;
}

function pitKey(pitId: string): string {
  return `pit:${pitId}`;
}

export async function createPit(record: PitRecord, ttlSeconds = DEFAULT_PIT_TTL_SECONDS): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(pitKey(record.pit_id), JSON.stringify(record), { EX: ttlSeconds });
      return;
    } catch {
      /* fall through */
    }
  }
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await query(
    `INSERT INTO link_pagination_session
       (pit_id, ontology_id, link_type_id, expires_at, backend, state)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (pit_id) DO UPDATE SET
       expires_at = EXCLUDED.expires_at,
       state      = EXCLUDED.state`,
    [
      record.pit_id,
      record.ontology_id,
      record.link_type_id ?? null,
      expiresAt,
      record.backend,
      JSON.stringify(record.state ?? {}),
    ]
  );
}

export async function touchPit(pitId: string, ttlSeconds = DEFAULT_PIT_TTL_SECONDS): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.expire(pitKey(pitId), ttlSeconds);
      return;
    } catch {
      /* fall through */
    }
  }
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await query(
    `UPDATE link_pagination_session SET expires_at = $2 WHERE pit_id = $1`,
    [pitId, expiresAt]
  );
}

export async function closePit(pitId: string): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(pitKey(pitId));
    } catch {
      /* ignore */
    }
  }
  await query(`DELETE FROM link_pagination_session WHERE pit_id = $1`, [pitId]).catch(
    () => undefined
  );
}

export async function loadPit(pitId: string): Promise<PitRecord | null> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get(pitKey(pitId));
      if (raw) return JSON.parse(raw) as PitRecord;
    } catch {
      /* fall through */
    }
  }
  const { rows } = await query(
    `SELECT pit_id, ontology_id, link_type_id, backend, state
       FROM link_pagination_session
      WHERE pit_id = $1 AND expires_at > now()`,
    [pitId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    pit_id: row.pit_id,
    ontology_id: row.ontology_id,
    link_type_id: row.link_type_id ?? undefined,
    backend: row.backend,
    state: row.state ?? {},
  };
}

export function newPitId(): string {
  // 128 bits of entropy via Node's crypto.randomUUID replacement — avoids
  // an external dep.
  try {
    const { randomUUID } = require("crypto");
    return `pit-${randomUUID()}`;
  } catch {
    return `pit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function isSearchAfterToken(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" && Array.isArray(parsed.sort_keys);
  } catch {
    return false;
  }
}
