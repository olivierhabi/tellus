// ---------------------------------------------------------------------------
// Overlay store singleton / factory — Task B7
//
// Wire-up is lazy: we attempt to connect to Redis on first use, fall back
// to an in-memory store if Redis is disabled (REDIS_URL unset) or
// unreachable. Once the fallback kicks in, it stays — we don't keep
// retrying on every query. A process restart re-tries Redis.
//
// Tests call `setOverlayStoreForTesting` to inject a MemoryOverlayStore
// directly.
// ---------------------------------------------------------------------------

import { OverlayStore } from "./overlayStore";
import { MemoryOverlayStore } from "./memoryStore";
import { RedisOverlayStore, MinimalRedisClient } from "./redisStore";

let store: OverlayStore | null = null;
let connecting: Promise<OverlayStore> | null = null;

export async function getOverlayStore(): Promise<OverlayStore> {
  if (store) return store;
  if (connecting) return connecting;

  connecting = (async () => {
    const url = process.env.REDIS_URL;
    if (!url) {
      console.log("[overlay] REDIS_URL unset — using in-memory overlay store");
      store = new MemoryOverlayStore();
      return store;
    }
    try {
      // Dynamic require so Redis is a soft dep. The `redis` npm package is
      // node-redis v4 compatible.
      const mod = await tryLoadRedis();
      if (!mod) {
        console.warn(
          "[overlay] 'redis' npm package not installed — falling back to in-memory store"
        );
        store = new MemoryOverlayStore();
        return store;
      }
      const client = mod.createClient({ url });
      client.on("error", (err: Error) => {
        console.warn(`[overlay] Redis error: ${err.message}`);
      });
      await client.connect();
      const adapter: MinimalRedisClient = {
        set: (k, v, o) => client.set(k, v, o as never),
        mGet: (keys) => client.mGet(keys),
        del: (keys) => client.del(keys as never),
        scan: async (cursor, opts) => {
          const res = (await client.scan(cursor as never, opts as never)) as {
            cursor: number | string;
            keys: string[];
          };
          return { cursor: res.cursor, keys: res.keys };
        },
        dbSize: () => client.dbSize(),
      };
      store = new RedisOverlayStore(adapter);
      console.log("[overlay] connected to Redis at", url);
      return store;
    } catch (err) {
      console.warn(
        `[overlay] Redis connect failed (${(err as Error).message}) — falling back to in-memory store`
      );
      store = new MemoryOverlayStore();
      return store;
    }
  })();

  const resolved = await connecting;
  connecting = null;
  return resolved;
}

interface RedisLikeClientFactory {
  createClient(opts: { url: string }): RedisLikeClient;
}

interface RedisLikeClient {
  connect(): Promise<void>;
  on(event: string, handler: (err: Error) => void): void;
  set(key: string, value: string, opts?: unknown): Promise<unknown>;
  mGet(keys: string[]): Promise<Array<string | null>>;
  del(keys: unknown): Promise<number>;
  scan(cursor: unknown, opts: unknown): Promise<unknown>;
  dbSize(): Promise<number>;
}

async function tryLoadRedis(): Promise<RedisLikeClientFactory | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("redis") as RedisLikeClientFactory;
  } catch {
    return null;
  }
}

export function setOverlayStoreForTesting(s: OverlayStore | null): void {
  store = s;
  connecting = null;
}
