/**
 * B5 — quiver_card_output_cache repository.
 *
 * Per B5 C-06 / C-07 / C-08:
 *   - Read respects cacheBehavior (READ_WRITE, READ_ONLY, BYPASS, REFRESH).
 *   - On hit: bump hit_count, refresh expires_at = NOW() + 1 hour.
 *   - On ontology bump for branch X: rows where ontology_version differs are
 *     ignored on read (and may be GC'd by the existing TTL sweep).
 *
 * Inline payloads (≤ 64 KB) live in `result_inline BYTEA`. Larger payloads
 * are stored via blob URI (Blobster equivalent — out of scope for the v1
 * cache landing; rejected at write-time with `RESULT_TOO_LARGE_FOR_INLINE`
 * per Decision Protocol "more restrictive default" — D-25).
 */

import type { Pool } from 'pg';
import { sha256Hex, canonicalJson } from './cacheKey';

export const INLINE_MAX_BYTES = 64 * 1024;

export class ResultTooLargeForInlineError extends Error {
  readonly code = 'RESULT_TOO_LARGE_FOR_INLINE';
  constructor(public readonly sizeBytes: number) {
    super(`result size ${sizeBytes} bytes exceeds inline cap ${INLINE_MAX_BYTES} bytes`);
    this.name = 'ResultTooLargeForInlineError';
  }
}

export interface CacheRow {
  cacheKey: string;
  analysisRid: string;
  cardId: string;
  cardType: string;
  branchRid: string;
  ontologyVersion: string;
  resultType: string;
  payload: unknown;
  contentHash: string;
  resultSizeBytes: number;
  computedAt: Date;
  expiresAt: Date;
  hitCount: number;
}

export interface CachePutInput {
  cacheKey: string;
  analysisRid: string;
  cardId: string;
  cardType: string;
  branchRid: string;
  ontologyVersion: string;
  resultType: string;
  payload: unknown;
  /** Optional precomputed contentHash; defaults to sha256(canonicalJson(payload)). */
  contentHash?: string;
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 3600;

export class CacheRepository {
  constructor(private readonly pool: Pool) {}

  /** GET cache row by key, refreshing TTL + bumping hit_count atomically. */
  async getAndTouch(cacheKey: string): Promise<CacheRow | null> {
    const sql = `
      UPDATE quiver_card_output_cache
      SET hit_count = hit_count + 1,
          expires_at = NOW() + INTERVAL '1 hour'
      WHERE cache_key = $1
        AND expires_at > NOW()
      RETURNING *
    `;
    const r = await this.pool.query(sql, [cacheKey]);
    if (r.rowCount === 0) return null;
    return rowToCacheRow(r.rows[0]);
  }

  /** Read-only peek (no TTL refresh) — for diagnostics. */
  async peek(cacheKey: string): Promise<CacheRow | null> {
    const r = await this.pool.query(
      `SELECT * FROM quiver_card_output_cache WHERE cache_key = $1 AND expires_at > NOW()`,
      [cacheKey],
    );
    if (r.rowCount === 0) return null;
    return rowToCacheRow(r.rows[0]);
  }

  async put(input: CachePutInput): Promise<CacheRow> {
    const payloadJson = canonicalJson(input.payload);
    const sizeBytes = Buffer.byteLength(payloadJson, 'utf8');
    if (sizeBytes > INLINE_MAX_BYTES) {
      throw new ResultTooLargeForInlineError(sizeBytes);
    }
    const contentHash = input.contentHash ?? sha256Hex(payloadJson);
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    const sql = `
      INSERT INTO quiver_card_output_cache (
        cache_key, analysis_rid, card_id, card_type, branch_rid,
        ontology_version, result_type, result_inline, result_size_bytes,
        computed_at, expires_at, hit_count
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        NOW(), NOW() + ($10 || ' seconds')::interval, 0
      )
      ON CONFLICT (cache_key) DO UPDATE SET
        result_type      = EXCLUDED.result_type,
        result_inline    = EXCLUDED.result_inline,
        result_size_bytes= EXCLUDED.result_size_bytes,
        computed_at      = NOW(),
        expires_at       = NOW() + ($10 || ' seconds')::interval,
        ontology_version = EXCLUDED.ontology_version
      RETURNING *
    `;
    const r = await this.pool.query(sql, [
      input.cacheKey,
      input.analysisRid,
      input.cardId,
      input.cardType,
      input.branchRid,
      input.ontologyVersion,
      input.resultType,
      Buffer.from(payloadJson, 'utf8'),
      sizeBytes,
      String(ttl),
    ]);
    const row = rowToCacheRow(r.rows[0]);
    row.contentHash = contentHash;
    return row;
  }

  /** B5 C-08 — invalidate all rows for (analysisRid, branch) whose ontology_version differs. */
  async invalidateOnOntologyBump(
    analysisRid: string,
    branchRid: string,
    currentOntologyVersion: string,
  ): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM quiver_card_output_cache
       WHERE analysis_rid = $1
         AND branch_rid = $2
         AND ontology_version <> $3`,
      [analysisRid, branchRid, currentOntologyVersion],
    );
    return r.rowCount ?? 0;
  }

  /** GC expired rows. Called by an external sweeper (no pg_cron dep — D-20). */
  async sweepExpired(): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM quiver_card_output_cache WHERE expires_at <= NOW()`,
    );
    return r.rowCount ?? 0;
  }

  /** Diagnostics: hit ratio over the last `windowSeconds` writes. */
  async hitRatio(windowSeconds = 600): Promise<number> {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(hit_count), 0)::bigint AS hits,
              COUNT(*)::bigint AS rows
       FROM quiver_card_output_cache
       WHERE computed_at > NOW() - ($1 || ' seconds')::interval`,
      [String(windowSeconds)],
    );
    const hits = Number(r.rows[0].hits);
    const rows = Number(r.rows[0].rows);
    if (rows === 0) return 0;
    return hits / (hits + rows);
  }
}

function rowToCacheRow(row: any): CacheRow {
  const payloadBuf: Buffer = row.result_inline;
  const payloadJson = payloadBuf?.toString('utf8') ?? 'null';
  let payload: unknown = null;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    payload = null;
  }
  return {
    cacheKey: row.cache_key,
    analysisRid: row.analysis_rid,
    cardId: row.card_id,
    cardType: row.card_type,
    branchRid: row.branch_rid,
    ontologyVersion: row.ontology_version,
    resultType: row.result_type,
    payload,
    contentHash: sha256Hex(payloadJson),
    resultSizeBytes: row.result_size_bytes,
    computedAt: new Date(row.computed_at),
    expiresAt: new Date(row.expires_at),
    hitCount: Number(row.hit_count),
  };
}
