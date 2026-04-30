// ---------------------------------------------------------------------------
// Redis-backed overlay store — Task B7
//
// Production implementation. Uses the node-redis v4 (or compatible) API via
// lazy require so the dependency is optional — dev environments without
// Redis use MemoryOverlayStore instead (see getOverlayStore.ts).
//
// The Redis commands we rely on:
//   SET key value EX <ttl>     — overlay write
//   MGET key1 key2 ...         — primary-key-indexed fetch for query merge
//   SCAN 0 MATCH pattern COUNT 500 — pre-index scan for overlays that
//                                    haven't yet been indexed
//   DEL key                    — sweeper deletion once indexed
// ---------------------------------------------------------------------------

import { OverlayRecord, OverlayStore } from "./overlayStore";

// We intentionally keep the Redis client type loose — it's a thin subset of
// node-redis v4 so we don't pull in its declarations just for the type.
export interface MinimalRedisClient {
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  mGet(keys: string[]): Promise<Array<string | null>>;
  del(keys: string | string[]): Promise<number>;
  scan(
    cursor: number | string,
    options?: { MATCH?: string; COUNT?: number }
  ): Promise<{ cursor: number | string; keys: string[] }>;
  dbSize(): Promise<number>;
}

export class RedisOverlayStore implements OverlayStore {
  constructor(private readonly client: MinimalRedisClient) {}

  async put(key: string, record: OverlayRecord, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(record), { EX: ttlSeconds });
  }

  async mget(keys: string[]): Promise<Array<OverlayRecord | null>> {
    if (keys.length === 0) return [];
    const raw = await this.client.mGet(keys);
    return raw.map((v) => (v ? (JSON.parse(v) as OverlayRecord) : null));
  }

  async scan(objectType: string): Promise<OverlayRecord[]> {
    const out: OverlayRecord[] = [];
    const pattern = `overlay:${objectType}:*`;
    let cursor: number | string = 0;
    do {
      const batch = await this.client.scan(cursor, {
        MATCH: pattern,
        COUNT: 500,
      });
      cursor = batch.cursor;
      if (batch.keys.length === 0) continue;
      const values = await this.client.mGet(batch.keys);
      for (const v of values) {
        if (v) out.push(JSON.parse(v) as OverlayRecord);
      }
    } while (String(cursor) !== "0");
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async size(): Promise<number> {
    return this.client.dbSize();
  }
}
